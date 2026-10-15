/* 书循环 · 前端应用（Vue3 + Element Plus，无构建步骤） */
(function () {
  'use strict';

  if (!window.Vue || !window.ElementPlus || !window.ElementPlusIconsVue) return;

  const apiBase = (window.APP_CONFIG && window.APP_CONFIG.apiBase || '').replace(/\/+$/, '');
  const { createApp, onMounted, reactive, ref } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;

  /** 统一 API 请求封装：自动带令牌、统一错误文案（网络失败 / 401 / 服务端 detail） */
  async function api(path, options) {
    if (!apiBase) {
      throw new Error('当前为独立前端，尚未连接后端 API');
    }
    options = options || {};
    const token = localStorage.getItem('token');
    const opts = {
      method: options.method || 'GET',
      headers: {},
    };
    if (token) opts.headers['X-Token'] = token;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        opts.body = options.body; /* 浏览器自动设置 multipart 边界 */
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(options.body);
      }
    }

    let res;
    try {
      res = await fetch(apiBase + path, opts);
    } catch (e) {
      const err = new Error('网络请求失败：无法连接后端服务，请确认服务已启动后重试');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应忽略 */ }
    if (!res.ok) {
      if (res.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const err = new Error((data && data.detail) || ('请求失败（HTTP ' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const OK_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_IMAGE_MB = 5;

  const app = createApp({
    setup() {
      const view = ref('home');
      const user = ref(null);
      try { user.value = JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { /* 忽略损坏缓存 */ }

      /* ---------- 登录 / 注册 ---------- */
      const loginForm = reactive({ username: '', password: '', loading: false });
      const regForm = reactive({ username: '', password: '', password2: '', wechat: '', loading: false });

      const flowSteps = [
        { icon: 'edit', t: '发布教材', d: '实拍图 + 绑定课程 + 定价' },
        { icon: 'chat-dot-round', t: '微信议价', d: '查看卖家微信，自行沟通' },
        { icon: 'location', t: '校园面交', d: '当面验书，线下结清钱款' },
        { icon: 'circle-check', t: '平台确认', d: '买家回平台确认订单完成' },
      ];

      function go(v) {
        if ((v === 'publish' || v === 'mybooks') && !user.value) {
          ElMessage.info('请先登录');
          v = 'login';
        }
        view.value = v;
        if (v === 'publish') loadCourses();
        if (v === 'mybooks') loadMyBooks();
        if (v === 'market') loadMarket();
        if (v === 'orders') loadOrders();
        window.scrollTo(0, 0);
      }

      function saveSession(token, u) {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(u));
        user.value = u;
      }
      function clearSession() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        user.value = null;
      }

      async function doLogin() {
        if (loginForm.loading) return; /* 防重复提交（FR-EXCEPTION-01） */
        if (!loginForm.username.trim()) { ElMessage.warning('请输入用户名'); return; }
        if (!loginForm.password) { ElMessage.warning('请输入密码'); return; }
        loginForm.loading = true;
        try {
          const r = await api('/auth/login', {
            method: 'POST',
            body: { username: loginForm.username.trim(), password: loginForm.password },
          });
          saveSession(r.token, r.user);
          ElMessage.success('欢迎回来，' + r.user.username);
          go('home');
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          loginForm.loading = false;
        }
      }

      function validateRegister() {
        const u = regForm.username.trim();
        if (u.length < 2 || u.length > 20) return '用户名需为 2-20 个字符';
        if (regForm.password.length < 6) return '密码至少 6 位';
        if (regForm.password !== regForm.password2) return '两次输入的密码不一致';
        if (regForm.wechat.trim().length > 50) return '微信号过长';
        return '';
      }

      async function doRegister() {
        if (regForm.loading) return; /* 防重复提交 */
        const msg = validateRegister();
        if (msg) { ElMessage.warning(msg); return; }
        regForm.loading = true;
        try {
          const r = await api('/auth/register', {
            method: 'POST',
            body: {
              username: regForm.username.trim(),
              password: regForm.password,
              wechat: regForm.wechat.trim() || null,
            },
          });
          saveSession(r.token, r.user);
          ElMessage.success('注册成功，已自动登录');
          go('home');
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          regForm.loading = false;
        }
      }

      async function logout() {
        try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* 令牌已失效也允许本地退出 */ }
        clearSession();
        ElMessage.success('已退出登录');
        go('home');
      }

      /* ---------- 课程 ---------- */
      const courses = ref([]);
      const coursesLoading = ref(false);
      async function loadCourses() {
        if (courses.value.length) return;
        coursesLoading.value = true;
        try {
          courses.value = await api('/courses');
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          coursesLoading.value = false;
        }
      }

      /* ---------- 书市（FR-BOOK-03） ---------- */
      const mk = reactive({ keyword: '', course_id: 0, sort: 'time_desc' });
      const mkBooks = ref([]);
      const mkTotal = ref(0);
      const mkState = ref('loading'); /* loading | done | error */
      const mkError = ref('');

      async function loadMarket() {
        mkState.value = 'loading';
        loadCourses();
        try {
          const params = new URLSearchParams();
          if (mk.keyword.trim()) params.set('keyword', mk.keyword.trim());
          if (mk.course_id) params.set('course_id', mk.course_id);
          params.set('sort', mk.sort);
          const r = await api('/books?' + params.toString());
          mkBooks.value = r.items;
          mkTotal.value = r.total;
          mkState.value = 'done';
        } catch (e) {
          mkError.value = e.message;
          mkState.value = 'error';
        }
      }

      function setCourse(id) {
        mk.course_id = id;
        loadMarket();
      }
      function searchBooks() { loadMarket(); }

      /* ---------- 教材详情（FR-BOOK-04） ---------- */
      const detail = reactive({ book: null, state: 'loading', error: '' });

      async function openDetail(id) {
        detail.book = null;
        detail.state = 'loading';
        view.value = 'detail';
        window.scrollTo(0, 0);
        try {
          detail.book = await api('/books/' + id);
          detail.state = 'done';
        } catch (e) {
          detail.error = e.message;
          detail.state = 'error';
        }
      }

      function backToMarket() {
        view.value = 'market';
        window.scrollTo(0, 0);
      }

      function copyWechat() {
        const wechat = detail.book && detail.book.seller_wechat;
        if (!wechat) return;
        const done = function () { ElMessage.success('微信号已复制：' + wechat); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(wechat).then(done, function () {
            ElMessage.warning('复制失败，请手动选择复制：' + wechat);
          });
        } else {
          ElMessage.warning('请手动复制：' + wechat);
        }
      }

      async function toggleCollect() {
        if (!user.value) {
          ElMessageBox.confirm('收藏需要先登录，现在去登录吗？', '提示', {
            confirmButtonText: '去登录', cancelButtonText: '取消', type: 'info',
          }).then(function () { go('login'); }).catch(function () { /* 取消 */ });
          return;
        }
        try {
          const r = await api('/books/' + detail.book.book_id + '/collect', { method: 'POST' });
          detail.book.collected = r.collected;
          ElMessage.success(r.collected ? '已加入收藏' : '已取消收藏');
        } catch (e) {
          ElMessage.error(e.message);
        }
      }

      /* ---------- 下单与订单中心（FR-ORDER-01~04） ---------- */
      async function placeOrder() {
        if (!user.value) {
          ElMessageBox.confirm('下单需要先登录，现在去登录吗？', '提示', {
            confirmButtonText: '去登录', cancelButtonText: '取消', type: 'info',
          }).then(function () { go('login'); }).catch(function () { /* 取消 */ });
          return;
        }
        const b = detail.book;
        if (!b) return;
        try {
          await ElMessageBox.confirm(
            '确认预约《' + b.book_name + '》？\n价格 ¥' + formatPrice(b.price) + '。线下面交、钱款当面结清，平台不代收；取消后会释放预约名额。',
            '交易确认', { confirmButtonText: '确认预约', cancelButtonText: '再想想', type: 'warning' }
          );
        } catch { return; }
        try {
          await api('/books/' + b.book_id + '/order', { method: 'POST' });
          ElMessage.success('预约成功，请加卖家微信约定面交');
          go('orders');
        } catch (e) {
          ElMessage.error(e.message);
        }
      }

      const ordersState = reactive({ role: 'buyer', list: [], loading: false, error: '' });
      async function loadOrders() {
        ordersState.loading = true;
        ordersState.error = '';
        try {
          ordersState.list = await api('/orders?role=' + ordersState.role);
        } catch (e) {
          ordersState.error = e.message;
        } finally {
          ordersState.loading = false;
        }
      }
      function switchOrders(role) { ordersState.role = role; loadOrders(); }
      function orderTagType(s) {
        return s === '待面交' ? 'warning' : s === '已完成' ? 'success' : 'info';
      }
      async function cancelOrder(o) {
        try {
          await ElMessageBox.confirm(
            '取消后《' + o.book_name + '》将释放预约名额。确认取消该订单？',
            '取消订单', { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '再想想' }
          );
        } catch { return; }
        try {
          await api('/orders/' + o.order_id + '/cancel', { method: 'POST' });
          ElMessage.success('已取消');
          loadOrders();
        } catch (e) { ElMessage.error(e.message); }
      }
      async function confirmOrder(o) {
        try {
          await ElMessageBox.confirm(
            '确认已当面验书付款并收到《' + o.book_name + '》？确认后订单完成，不可撤销。',
            '确认完成', { type: 'warning', confirmButtonText: '确认完成', cancelButtonText: '再想想' }
          );
        } catch { return; }
        try {
          await api('/orders/' + o.order_id + '/confirm', { method: 'POST' });
          ElMessage.success('订单已完成');
          loadOrders();
        } catch (e) { ElMessage.error(e.message); }
      }

      /* ---------- 发布教材 ---------- */
      const pub = reactive({ book_name: '', course_id: null, price: null, quality_desc: '', file: null, loading: false });
      const pubFiles = ref([]);

      function clearPic() {
        pub.file = null;
        pubFiles.value = [];
      }

      function applyRaw(raw, keepList) {
        if (!OK_IMAGE_TYPES.includes(raw.type)) {
          ElMessage.error('仅支持 JPG / PNG / WebP 格式图片');
          clearPic();
          return false;
        }
        if (raw.size > MAX_IMAGE_MB * 1024 * 1024) {
          ElMessage.error('图片不能超过 ' + MAX_IMAGE_MB + 'MB，请压缩后重新上传');
          clearPic();
          return false;
        }
        pub.file = raw;
        return true;
      }

      function onPicChange(file, fileList) {
        if (!file.raw) return; /* 移除触发时 raw 为空 */
        const ok = applyRaw(file.raw);
        if (!ok) pubFiles.value = fileList.filter(function (f) { return f.uid !== file.uid; });
      }
      function onPicRemove() { pub.file = null; }
      function onPicExceed(files) {
        const raw = files[0];
        if (!raw) return;
        pubFiles.value = [{ name: raw.name, raw: raw, status: 'ready', uid: Date.now() }];
        applyRaw(raw);
      }

      function validatePublish() {
        if (!pub.book_name.trim()) return '请填写书名';
        if (!pub.course_id) return '请选择所属课程';
        if (!(pub.price > 0)) return '请填写有效的售价（大于 0）';
        if (!pub.file) return '请上传教材实拍图片';
        return '';
      }

      async function doPublish() {
        if (pub.loading) return; /* 防重复提交 */
        const msg = validatePublish();
        if (msg) { ElMessage.warning(msg); return; }
        pub.loading = true;
        try {
          const fd = new FormData();
          fd.append('book_name', pub.book_name.trim());
          fd.append('course_id', pub.course_id);
          fd.append('price', pub.price);
          fd.append('quality_desc', pub.quality_desc.trim());
          fd.append('image', pub.file);
          const book = await api('/books', { method: 'POST', body: fd });
          ElMessage.success('《' + book.book_name + '》发布成功');
          pub.book_name = ''; pub.course_id = null; pub.price = null;
          pub.quality_desc = ''; clearPic();
          go('mybooks');
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          pub.loading = false;
        }
      }

      /* ---------- 我的发布 ---------- */
      const myBooks = ref([]);
      const myState = ref('loading'); /* loading | done | error */
      const myError = ref('');

      async function loadMyBooks() {
        myState.value = 'loading';
        try {
          myBooks.value = await api('/books/mine');
          myState.value = 'done';
        } catch (e) {
          myError.value = e.message;
          myState.value = 'error';
        }
      }

      function delistBook(b) {
        ElMessageBox.confirm(
          '下架后《' + b.book_name + '》将不会出现在书市中，已产生的订单不受影响。确定下架吗？',
          '下架确认',
          { type: 'warning', confirmButtonText: '确认下架', cancelButtonText: '再想想' }
        ).then(async function () {
          try {
            await api('/books/' + b.book_id + '/delist', { method: 'POST' });
            ElMessage.success('已下架');
            loadMyBooks();
          } catch (e) {
            ElMessage.error(e.message);
          }
        }).catch(function () { /* 用户取消 */ });
      }

      async function relistBook(b) {
        try {
          await api('/books/' + b.book_id + '/relist', { method: 'POST' });
          ElMessage.success('已重新上架');
          loadMyBooks();
        } catch (e) {
          ElMessage.error(e.message);
        }
      }

      function formatPrice(v) { return Number(v).toFixed(2); }

      onMounted(async () => {
        /* 刷新页面后校验本地令牌是否仍有效（会话保持） */
        if (localStorage.getItem('token')) {
          try {
            const u = await api('/auth/me');
            user.value = u;
            localStorage.setItem('user', JSON.stringify(u));
          } catch (e) {
            if (e.status === 401) {
              clearSession();
              ElMessage.info('登录已过期，请重新登录');
            }
            /* 网络失败等其他情况：保留本地会话，不打扰用户 */
          }
        }
      });

      return {
        view, user, loginForm, regForm, flowSteps,
        courses, coursesLoading,
        pub, pubFiles, onPicChange, onPicRemove, onPicExceed, doPublish,
        myBooks, myState, myError, loadMyBooks, delistBook, relistBook,
        mk, mkBooks, mkTotal, mkState, mkError, loadMarket, setCourse, searchBooks,
        detail, openDetail, backToMarket, copyWechat, toggleCollect,
        ordersState, loadOrders, switchOrders, orderTagType, cancelOrder, confirmOrder, placeOrder,
        formatPrice,
        go, doLogin, doRegister, logout,
      };
    },
  });

  app.use(ElementPlus);
  Object.entries(ElementPlusIconsVue).forEach(function (entry) {
    app.component(entry[0], entry[1]);
  });
  app.mount('#app');
})();
