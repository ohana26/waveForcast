// wave-alert.js
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

// --- Config ---
const THRESHOLD_METERS = 0.8;   // min wave height in meters
const LOOKAHEAD_DAYS = 2;       // days ahead to check
const TZ = 'Asia/Jerusalem';    // timezone for formatting

const LOCATIONS = [
  { name: 'Tel Aviv', lat: 32.0809, lon: 34.7806 },
  { name: 'Haifa', lat: 32.7940, lon: 34.9896 },
  { name: 'Ashdod', lat: 31.8014, lon: 34.6435 }
];

const RECIPIENTS = (process.env.ALERT_TO_EMAILS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// --- Nodemailer setup ---
console.log('Using email:', process.env.MAIL_USER, '->', RECIPIENTS);
const transporter = nodemailer.createTransport({
  service: process.env.MAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

async function sendMail(message) {
  const mailOptions = {
    from: process.env.MAIL_USER,
    to: RECIPIENTS,
    subject: '🌊 Daily Wave Alert',
    text: message
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('[MAIL] Sent to:', RECIPIENTS.join(", "));
  } catch (err) {
    console.error('[MAIL] Error:', err.message);
  }
}

// --- Helpers ---
function metersToCm(m) {
  return Math.round(m * 100);
}
function fmtHourLocal(iso) {
  return new Date(iso).toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}
async function fetchWaveForecast(lat, lon) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height&timezone=${TZ}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
function nextExceedances(hourly, threshold, daysAhead) {
  const now = Date.now();
  const cutoff = now + daysAhead * 24 * 3600 * 1000;
  const hits = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const t = new Date(hourly.time[i]);
    if (t > cutoff) break;
    if (hourly.wave_height[i] >= threshold) {
      hits.push({ iso: hourly.time[i], meters: hourly.wave_height[i] });
    }
  }
  return hits;
}

// --- Core logic ---
async function checkLocation(loc) {
  try {
    const forecast = await fetchWaveForecast(loc.lat, loc.lon);
    const hits = nextExceedances(forecast.hourly, THRESHOLD_METERS, LOOKAHEAD_DAYS);

    if (hits.length === 0) {
      return `[${loc.name}] No waves ≥ ${THRESHOLD_METERS}m in next ${LOOKAHEAD_DAYS} days`;
    }

    // Group hits by day
    const grouped = {};
    for (const h of hits) {
      const d = new Date(h.iso).toLocaleDateString('en-IL', { weekday: 'short', timeZone: TZ });
      grouped[d] = grouped[d] || [];
      grouped[d].push(h);
    }

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
}

async function runOnce() {
  console.log(`\n[${new Date().toLocaleString('en-IL', { timeZone: TZ })}] Checking ${LOCATIONS.length} locations...`);

  const reports = [];
  for (const loc of LOCATIONS) {
    reports.push(await checkLocation(loc));
  }

  const msg = reports.join('\n\n');
  await sendMail(msg);
}

// Run once
runOnce();
