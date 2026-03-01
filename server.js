require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const sheetId = process.env.SPREADSHEET_ID;
// Ambil Admin ID dari env, kalau kosong akan diisi otomatis saat kamu nge-chat
let adminChatId = process.env.ADMIN_CHAT_ID || null; 

const bot = new TelegramBot(botToken, { polling: true });
const genAI = new GoogleGenerativeAI(geminiApiKey);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Auth untuk Sheets & Calendar
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar' 
  ],
});
const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);

// ==========================================
// 1. SETUP GOOGLE CALENDAR
// ==========================================
const calendar = google.calendar({ version: 'v3', auth: serviceAccountAuth });
const calendarId = process.env.CALENDAR_ID;

const buatEventGantiOli = async (tanggalPerkiraan, kmTarget) => {
  try {
    const event = {
      summary: 'Waktunya Ganti Oli Motor! 🏍️',
      description: `Target KM ganti oli: ${kmTarget}. Segera cek kondisi motor.`,
      start: { date: tanggalPerkiraan }, 
      end: { date: tanggalPerkiraan }, 
    };

    await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
    });
    console.log(`[Calendar] Event ganti oli berhasil dibuat untuk tanggal ${tanggalPerkiraan}`);
  } catch (error) {
    console.error('[Calendar] Gagal membuat event:', error);
  }
};

// ==========================================
// 2. PROMPT & FUNGSI EKSTRAK JSON
// ==========================================
const promptGantiOli = `Kamu adalah AI asisten mekanik motor.
Tugasmu mengekstrak informasi kilometer (KM) dari chat user ke dalam format JSON.

Ada 2 tipe laporan user:
1. "update_km": User cuma lapor posisi KM saat ini (contoh: "km motor hari ini 72300").
2. "ganti_oli": User lapor dia BARU SAJA ganti oli (contoh: "abis ganti oli nih di km 72500").

Struktur JSON TEPAT seperti ini:
{
  "intent": "update_km" atau "ganti_oli",
  "km_angka": 72500,
  "catatan": "alasan atau null"
}

ATURAN KETAT:
- km_angka wajib angka integer (hilangkan titik/koma, misal 72.500 jadi 72500).
- Kembalikan HANYA JSON murni, tanpa markdown, tanpa teks lain.`;

const ekstrakJson = (rawText) => {
  let cleaned = rawText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  let start = cleaned.indexOf('{');
  let end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("Format JSON tidak ditemukan.");
  return JSON.parse(cleaned.substring(start, end + 1));
};

const prosesChatDenganGroq = async (text) => {
  const response = await groq.chat.completions.create({
    messages: [{ role: "user", content: `${promptGantiOli}\n\nChat user: "${text}"` }],
    model: "llama-3.3-70b-versatile",
    temperature: 0,
  });
  return ekstrakJson(response.choices[0]?.message?.content);
};

// ==========================================
// 3. FUNGSI UPDATE GOOGLE SHEETS
// ==========================================
const updateDataMotor = async (chatId, dataAI) => {
  try {
    bot.sendMessage(chatId, '⏳ Mengamankan data ke sistem...');
    await doc.loadInfo();
    
    // Ambil Sheet 1 (Status) dan Sheet 2 (History)
    const sheetStatus = doc.sheetsByIndex[0];
    const sheetHistory = doc.sheetsByIndex[1]; 
    
    const rowsStatus = await sheetStatus.getRows();
    const rowStatus = rowsStatus[0]; 
    
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const tanggalHariIni = timestamp.split(',')[0]; 
    
    let pesanBalasan = '';
    let tipeLaporan = '';

    if (dataAI.intent === 'ganti_oli') {
      const targetBaru = dataAI.km_angka + 2000;
      tipeLaporan = 'Ganti Oli';
      
      // Update Sheet 1
      rowStatus.assign({
        'Tanggal Update': tanggalHariIni,
        'KM Sekarang': dataAI.km_angka,
        'KM Terakhir Ganti': dataAI.km_angka,
        'Target KM Ganti': targetBaru
      });
      pesanBalasan = `✅ **Asiap Bos! Ganti Oli Tercatat.**\n\n📅 Tanggal: ${tanggalHariIni}\n🏍️ KM Ganti: ${dataAI.km_angka}\n🎯 Target Ganti Berikutnya: ${targetBaru}\n\nJangan lupa panasin motor tiap pagi!`;

      // Buat event di Calendar untuk 2 bulan ke depan
      const tanggalPerkiraan = new Date();
      tanggalPerkiraan.setMonth(tanggalPerkiraan.getMonth() + 2);
      const formattedDate = tanggalPerkiraan.toISOString().split('T')[0]; 
      
      await buatEventGantiOli(formattedDate, targetBaru);
      pesanBalasan += `\n\n🗓️ _Jadwal pengingat otomatis telah ditambahkan ke Google Calendar kamu._`;

    } 
    else {
      const targetKM = parseInt(rowStatus.get('Target KM Ganti'));
      const sisaKM = targetKM - dataAI.km_angka;
      tipeLaporan = 'Update Harian';
      
      // Update Sheet 1
      rowStatus.assign({
        'Tanggal Update': tanggalHariIni,
        'KM Sekarang': dataAI.km_angka
      });
      
      pesanBalasan = `✅ **KM Berhasil Diupdate!**\n\n📅 Tanggal: ${tanggalHariIni}\n🏍️ KM Saat Ini: ${dataAI.km_angka}\n🎯 Target Servis: ${targetKM}\n\n⚠️ Sisa jarak aman: **${sisaKM} KM** lagi.`;
    }

    // --- FITUR BARU: Tambah Log History ke Sheet 2 (Baris ke bawah) ---
    await sheetHistory.addRow([
      tanggalHariIni,
      dataAI.km_angka,
      tipeLaporan,
      dataAI.catatan || '-'
    ]);

    // Save perubahan di Sheet 1
    await rowStatus.save();
    bot.sendMessage(chatId, pesanBalasan, { parse_mode: "Markdown" });

  } catch (error) {
    console.error("Gagal update Sheets:", error);
    bot.sendMessage(chatId, '❌ Waduh, gagal nyimpen ke Google Sheets. Cek terminal ya.');
  }
};

// ==========================================
// 4. LISTENER TELEGRAM BOT
// ==========================================
bot.onText(/\/start/, (msg) => {
  adminChatId = msg.chat.id; // Simpan chat ID saat start
  bot.sendMessage(adminChatId, `Halo bos! 🏍️\n\nBot perawatan motor siap jalan. Nanti tinggal chat update KM tiap hari, biar ganti oli nggak kelewat lagi.\n\n_(Chat ID kamu: ${adminChatId} - Tambahkan ini ke .env sebagai ADMIN_CHAT_ID ya!)_`);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  adminChatId = chatId; // Selalu update admin ID ke interaksi terakhir
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  try {
    bot.sendMessage(chatId, '🤖 Llama 3 lagi mikir...');
    const dataAI = await prosesChatDenganGroq(text);
    await updateDataMotor(chatId, dataAI);
  } catch (error) {
    console.error("Error AI/Proses:", error);
    bot.sendMessage(chatId, '❌ Wah, AI-nya gagal paham. Coba pakai bahasa yang lebih jelas angkanya.');
  }
});

// ==========================================
// 5. CRON JOBS (PENJADWALAN OTOMATIS)
// ==========================================

// Cron Harian: Tagih Update KM tiap jam 20:00 WIB
cron.schedule('0 20 * * *', async () => {
  if (!adminChatId) return; 

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const rowStatus = rows[0];

    const tanggalHariIni = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).split(',')[0];
    const tanggalUpdateTerakhir = rowStatus.get('Tanggal Update');

    if (tanggalUpdateTerakhir !== tanggalHariIni) {
      bot.sendMessage(adminChatId, `🔔 **Halo Bos Akbar!**\n\nHari ini belum lapor posisi KM nih. Sekarang motormu di KM berapa? Balas chat ini ya!`);
    }
  } catch (error) {
    console.error("[Cron Harian] Error:", error);
  }
}, { timezone: "Asia/Jakarta" });

// Cron Mingguan: Cek Kondisi Oli (Tiap Hari Minggu Jam 10:00 WIB)
cron.schedule('0 10 * * 0', async () => {
  if (!adminChatId) return;

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const rowStatus = rows[0];

    const kmSekarang = parseInt(rowStatus.get('KM Sekarang'));
    const targetKM = parseInt(rowStatus.get('Target KM Ganti'));
    const sisaKM = targetKM - kmSekarang;

    if (sisaKM <= 200) {
      bot.sendMessage(adminChatId, `🚨 **PERINGATAN GANTI OLI!** 🚨\n\nSisa jarak aman motormu tinggal **${sisaKM} KM** lagi (Target: ${targetKM}).\n\nSiapin dana dan segera meluncur ke bengkel bos! 🛠️`);
    } else {
       bot.sendMessage(adminChatId, `📊 **Laporan Mingguan Motor:**\n\nSaat ini posisi di **${kmSekarang} KM**.\nSisa jarak aman ke ganti oli berikutnya: **${sisaKM} KM**.`);
    }
  } catch (error) {
    console.error("[Cron Mingguan] Error:", error);
  }
}, { timezone: "Asia/Jakarta" });

// ==========================================
// 6. SERVER EXPRESS
// ==========================================
app.get('/', (req, res) => {
  res.send('Server Bot Ganti Oli Berjalan Lancar!');
});

app.listen(port, () => {
  console.log(`🚀 Server jalan di http://localhost:${port}`);
  console.log('🤖 Bot Ganti Oli siap menerima perintah!');
});