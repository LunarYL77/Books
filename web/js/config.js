/* Cloudflare Pages Functions 与前端同域，无需配置跨域。 */
window.APP_CONFIG = {
  apiBase: window.location.protocol === 'file:' ? '' : '/api',
};
