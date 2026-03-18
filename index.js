const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const admin = require('firebase-admin');
const cors = require('cors');
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function diasVencidos(fechaStr) {
  if (!fechaStr) return null;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const fecha = new Date(fechaStr + 'T00:00:00');
  const diff = Math.floor((hoy - fecha) / 86400000);
  return diff > 0 ? diff : null;
}

function getProximaFecha(c) {
  if (c.tipo === 'prestamo') return c.fechaPago || null;
  if (c.tipo === 'plazo') {
    if (c.semanasVencidas && c.semanasVencidas.length > 0) return c.semanasVencidas[0].fechaPago;
    return c.fechaPago || null;
  }
  if (c.tipo === 'mercancia') {
    const pagos = c.pagos || [];
    const p = pagos.find(s => !s.pagado);
    return p ? p.fecha : null;
  }
  return null;
}

async function hacerLlamada(telefono, diasV) {
  const tel = telefono.replace(/\D/g,'');
  const telF = tel.startsWith('52') ? `+${tel}` : `+52${tel}`;
  const unidad = diasV === 1 ? '1 día vencido' : `${diasV} días vencidos`;
  const msg = `Credi Aliado. Le recordamos que cuenta con ${unidad}. Por favor comuníquese con su asesor asignado.`;
  try {
    const call = await client.calls.create({
      twiml: `<Response><Say language="es-MX" voice="Polly.Mia">${msg}</Say><Pause length="1"/><Say language="es-MX" voice="Polly.Mia">${msg}</Say></Response>`,
      to: telF, from: TWILIO_PHONE_NUMBER
    });
    console.log(`✅ Llamada a ${telF} SID: ${call.sid}`);
    return true;
  } catch (err) {
    console.error(`❌ Error ${telF}:`, err.message);
    return false;
  }
}

async function procesarLlamadas(slot) {
  console.log(`🔔 Slot ${slot} - ${new Date().toISOString()}`);
  try {
    const snap = await db.collection('datos').doc('clientes').get();
    if (!snap.exists) return;
    const clientes = snap.data().clientes || [];
    for (const c of clientes) {
      if (!c.tel || c.llamadaAutoOff === true || c.liquidado) continue;
      const fecha = getProximaFecha(c);
      if (!fecha) continue;
      const dias = diasVencidos(fecha);
      if (!dias) continue;
      let maxSlot = 1;
      if (dias === 3) maxSlot = 2;
      if (dias === 4) maxSlot = 3;
      if (dias >= 5) maxSlot = 4;
      if (slot > maxSlot) continue;
      console.log(`📞 ${c.nombre} - ${dias}d vencido`);
      await hacerLlamada(c.tel, dias);
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log(`✅ Slot ${slot} completado`);
  } catch (err) { console.error('Error:', err); }
}

// Horarios México (UTC-6): 9AM=15UTC, 2PM=20UTC, 6PM=0UTC, 8PM=2UTC
cron.schedule('0 15 * * *', () => procesarLlamadas(1));
cron.schedule('0 20 * * *', () => procesarLlamadas(2));
cron.schedule('0 0 * * *',  () => procesarLlamadas(3));
cron.schedule('0 2 * * *',  () => procesarLlamadas(4));

app.get('/', (req, res) => res.json({ status: '✅ Credi Aliado Server activo', hora: new Date().toLocaleString('es-MX', {timeZone:'America/Mazatlan'}) }));

app.post('/llamada-prueba', async (req, res) => {
  const { telefono, dias } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Falta teléfono' });
  const ok = await hacerLlamada(telefono, parseInt(dias)||1);
  res.json({ success: ok });
});

app.post('/procesar/:slot', async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (slot<1||slot>4) return res.status(400).json({ error: 'Slot inválido' });
  await procesarLlamadas(slot);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
