// QRDraw wrapper for qrcode-generator (MIT)
// Exposes window.QRDraw(canvas, text, scale)
window.QRDraw = function(canvas, text, scale) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var s = scale || 4;
  canvas.width = n * s;
  canvas.height = n * s;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(c * s, r * s, s, s);
    }
  }
};

