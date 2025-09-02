import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cron from 'node-cron';
import sgMail from '@sendgrid/mail';

dotenv.config();

// --- Config ---
const THRESHOLD_METERS = parseFloat(process.env.THRESHOLD_METERS) || 0.8;
const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS, 10) || 2;
const TZ = process.env.TZ || 'Asia/Jerusalem';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 18 * * *';

// --- Locations from .env ---
const LOCATIONS = (process.env.LOCATIONS || '')
  .split(',')
  .map(str => {
    const [name, lat, lon] = str.split('|');
    return { name, lat: parseFloat(lat), lon: parseFloat(lon) };
  })
  .filter(loc => loc.name && !isNaN(loc.lat) && !isNaN(loc.lon));

// --- Recipients ---
const RECIPIENTS = (process.env.ALERT_TO_EMAILS || '')
  .split(',')
  .map(email => email.trim())
  .filter(Boolean);

// --- SendGrid Init ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Helpers ---
const metersToCm = m => Math.round(m * 100);

const fmtHourLocal = iso =>
  new Date(iso).toLocaleTimeString('en-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });

const fetchWaveForecast = async (lat, lon) => {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height&timezone=${TZ}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
};

const nextExceedances = (hourly, threshold, daysAhead) => {
  const now = Date.now();
  const cutoff = now + daysAhead * 24 * 3600 * 1000;
  const hits = [];

  hourly.time.forEach((time, i) => {
    const t = new Date(time);
    if (t > cutoff) return;
    if (hourly.wave_height[i] >= threshold) hits.push({ iso: time, meters: hourly.wave_height[i] });
  });

  return hits;
};

// --- SendGrid Mail Wrapper ---
const sendMailAsync = async message => {
  const msg = {
    to: RECIPIENTS,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: '🌊 Daily Wave Alert (Ohana is king)',
    text: message,
    html: `<pre>${message}</pre>`
  };

  await sgMail.send(msg);
};

// --- Core logic ---
const checkLocation = async loc => {
  try {
    const forecast = await fetchWaveForecast(loc.lat, loc.lon);
    const hits = nextExceedances(forecast.hourly, THRESHOLD_METERS, LOOKAHEAD_DAYS);

    if (!hits.length) return `[${loc.name}] No waves ≥ ${THRESHOLD_METERS}m in next ${LOOKAHEAD_DAYS} days`;

    const grouped = hits.reduce((acc, h) => {
      const day = new Date(h.iso).toLocaleDateString('en-IL', { weekday: 'short', timeZone: TZ });
      acc[day] = acc[day] || [];
      acc[day].push(h);
      return acc;
    }, {});

    const lines = Object.entries(grouped).map(([day, arr]) => {
      const max = arr.reduce((a, b) => (a.meters > b.meters ? a : b));
      return `- ${day}: peak ~${metersToCm(max.meters)} cm at ${fmtHourLocal(max.iso)}`;
    });

    return [
      `🌊 ${loc.name} (Lat/Lon: ${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)})`,
      `Threshold: ${Math.round(THRESHOLD_METERS * 100)} cm`,
      ...lines
    ].join('\n');
  } catch (err) {
    return `[${loc.name}] Error: ${err.message}`;
  }
};

// --- Run all locations in parallel ---
const runOnce = async () => {
  console.log(`\n[${new Date().toLocaleString('en-IL', { timeZone: TZ })}] Checking ${LOCATIONS.length} locations...`);

  try {
    const reports = await Promise.all(LOCATIONS.map(checkLocation));
    const msg = reports.join('\n\n');
    await sendMailAsync(msg);
    console.log('[MAIL] Sent successfully');
  } catch (err) {
    console.error('[MAIL] Error:', err.message);
  }
};

// --- Main ---
const main = () => {
  cron.schedule(CRON_SCHEDULE, runOnce, { timezone: TZ });
  console.log(`Wave alert scheduled at "${CRON_SCHEDULE}" (${TZ})`);
  runOnce(); // run immediately
};

main();
