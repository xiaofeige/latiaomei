// 定位小工具：只为「附近转盘」在本地算直线距离。
// 坐标不进请求、不落存储 —— 用户位置零上传，隐私协议好写。
function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 精确定位（gcj02）。注：getFuzzyLocation 与 getLocation 在 app.json 里二选一互斥，
// 附近筛选要算真实距离，模糊坐标（2km 误差）不够用，所以只声明 getLocation。
function locate() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02', isHighAccuracy: false, timeout: 8000,
      success: (r) => resolve({ lat: r.latitude, lng: r.longitude, fuzzy: false }),
      fail: (e) => reject(e),
    });
  });
}

// 距离文案：1km 内报米，往外报一位小数
function kmText(km) {
  return km < 1 ? Math.round(km * 1000) + 'm' : km.toFixed(1) + 'km';
}

module.exports = { distanceKm, locate, kmText };
