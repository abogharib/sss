const socket = io();

// عرض الباركود عند استلامه من السيرفر
socket.on('qr', (qr) => {
  const qrDiv = document.getElementById('qrcode');
  if (qrDiv) {
    qrDiv.innerHTML = ""; // مسح الباركود السابق
    new QRCode(qrDiv, {
      text: qr,
      width: 256,
      height: 256,
    });
  }
});

// تحديث حالة الاتصال عند نجاح الربط
socket.on('connected', (data) => {
  console.log('Connected:', data);
  window.location.reload();
});

// تحديث الحالة عند فصل الاتصال
socket.on('disconnected', () => {
  console.log('Disconnected from WhatsApp');
  window.location.reload();
});

// عند تغيير حالة التشغيل من العميل
document.addEventListener('DOMContentLoaded', () => {
  const toggleCheckbox = document.querySelector('input[name="isActive"]');
  if (toggleCheckbox) {
    toggleCheckbox.addEventListener('change', () => {
      socket.emit('toggle', toggleCheckbox.checked);
    });
  }
});
