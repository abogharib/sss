require('dotenv').config();
const { DisconnectReason, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;

const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

// ─── تهيئة قاعدة البيانات ──────────────────────────────
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'database.sqlite'),
  logging: false
});

// ─── نماذج البيانات ────────────────────────────────────
const Session = sequelize.define('Session', {
  sessionId: { type: DataTypes.STRING, primaryKey: true },
  data: DataTypes.JSON
});

const Settings = sequelize.define('Settings', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
  message: { type: DataTypes.STRING, defaultValue: 'Hello from Bot!' },
  phone: { type: DataTypes.STRING, allowNull: true }
});

// ─── إعداد إكسبريس ─────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// ─── تشغيل السيرڤر ─────────────────────────────────────
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.green(`السيرفر يعمل على البورت ${PORT}`));
});

// ─── ويب سوكيت للتحديث الفوري ───────────────────────────
const io = socketIO(server);

// ─── متغيرات البوت ─────────────────────────────────────
let sock = null;
let isSending = false;
let qrCode = null;
let sendingInterval = null;

// ─── دالة تهيئة البوت ──────────────────────────────────
async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('session');

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: {
      child: () => ({ 
        trace: () => {}, 
        debug: () => {}, 
        info: () => {}, 
        warn: () => {}, 
        error: () => {} 
      }),
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  });

  sock.ev.on('connection.update', async (update) => {
    console.log(chalk.yellow('Connection Update:'), update);

    // إرسال باركود جديد للواجهة عند ظهوره
    if (update.qr) {
      qrCode = update.qr;
      io.emit('qr', qrCode);
    }

    // عند نجاح الاتصال، تحديث بيانات الحساب وإعلام الواجهة
    if (update.connection === 'open') {
      const user = sock.user;
      const phone = user.id.replace(/:.*/, '');
      await Settings.update({ isActive: false, phone }, { where: { id: 1 } });
      io.emit('connected', { phone, status: 'connected' });
    }

    // عند قطع الاتصال
    if (update.connection === 'close') {
      console.log(chalk.red('Connection closed, reinitializing...'));

      // إيقاف دورة الإرسال التلقائي إذا كانت تعمل
      if (sendingInterval) {
        clearInterval(sendingInterval);
        sendingInterval = null;
      }
      isSending = false;

      // إذا كان فصل الجلسة بسبب تسجيل الخروج، حذف بيانات الجلسة القديمة
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(chalk.red('تم تسجيل الخروج، جارٍ حذف بيانات الجلسة القديمة.'));
        try {
          fs.rmSync(path.join(__dirname, 'session'), { recursive: true, force: true });
        } catch (err) {
          console.error(chalk.red('خطأ أثناء حذف مجلد الجلسة:'), err);
        }
      }

      // تحديث الحالة وإعلام الواجهة بأن الجلسة غير متصلة
      await Settings.update({ phone: null, isActive: false }, { where: { id: 1 } });
      io.emit('disconnected');

      // تأخير بسيط قبل إعادة تهيئة البوت لتفادي دورات إعادة الاتصال السريعة
      setTimeout(() => {
        initWhatsApp();
      }, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── دورة الإرسال التلقائي ──────────────────────────────
function startSendingLoop() {
  if (sendingInterval) return;
  sendingInterval = setInterval(async () => {
    if (sock && isSending) {
      const settings = await Settings.findOne({ where: { id: 1 } });
      const message = settings?.message || 'Hello from Bot!';
      const phone = sock.user?.id.replace(/:.*/, '');
      try {
        await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
        console.log(chalk.blue(`تم إرسال الرسالة إلى ${phone}`));
      } catch (error) {
        console.error(chalk.red('خطأ أثناء إرسال الرسالة:'), error);
      }
    }
  }, 5000);
}

// ─── Routes ────────────────────────────────────────────
app.get('/', async (req, res) => {
  const settings = await Settings.findOne({ where: { id: 1 } });
  res.render('dashboard', { settings });
});

app.post('/update-settings', async (req, res) => {
  const { message, isActive } = req.body;
  const activeStatus = isActive === 'on';
  await Settings.update({ message, isActive: activeStatus }, { where: { id: 1 } });
  isSending = activeStatus;
  if (activeStatus) {
    startSendingLoop();
  } else if (sendingInterval) {
    clearInterval(sendingInterval);
    sendingInterval = null;
  }
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  if (sock) {
    await sock.logout();
    sock = null;
  }
  await Session.destroy({ where: {} });
  await Settings.update({ phone: null, isActive: false }, { where: { id: 1 } });
  io.emit('disconnected');
  // إعادة تهيئة البوت بعد تأخير بسيط لعرض QR جديد دون توقف السيرفر
  setTimeout(() => {
    initWhatsApp();
  }, 3000);
  res.redirect('/');
});

// ─── تهيئة التطبيق ─────────────────────────────────────
async function initialize() {
  await sequelize.sync({ force: false });
  await Settings.findOrCreate({ where: { id: 1 } });
  
  io.on('connection', (socket) => {
    // استقبال حدث toggle من العميل لتحديث حالة الإرسال الفوري
    socket.on('toggle', async (activeStatus) => {
      isSending = activeStatus;
      if (activeStatus) {
        startSendingLoop();
      } else if (sendingInterval) {
        clearInterval(sendingInterval);
        sendingInterval = null;
      }
    });
  });

  initWhatsApp();
}

initialize();
