// 管理后台小程序全局配置。
// 注意：这里只放可公开的常量。上传密钥 private.<appid>.key 只用于本地 CI 上传，
// 绝不会打进小程序包，也不参与运行时。
module.exports = {
  // 小程序包内版本常量：CI upload/preview 时自动改写成 --v 的值，「我的→运维」展示用。
  // 微信运行时只在正式版给版本号，体验/开发版要靠这个常量兜底，别手动改它。
  APP_VERSION: '1.12.0',

  // 后端基址（HTTPS，且已在公众平台配置为 request / uploadFile / downloadFile 合法域名）
  API_BASE: 'https://latiaomei.infinityfly.xin',
  API_PREFIX: '/api',
  REQUEST_TIMEOUT: 20000,

  // 图片等静态资源基址（/uploads/... 与 /img/... 都由同一个 Go 服务托管）
  ASSET_BASE: 'https://latiaomei.infinityfly.xin',
};
