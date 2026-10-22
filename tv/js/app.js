/* KinoPub for Samsung Orsay (2013). ES5 only: the TV's browser is ancient. */

var PROXY = '__PROXY__'; // filled in by the proxy when it serves the app
if (PROXY.charAt(0) === '_') {
	// unbuilt copy opened in a desktop browser: index.html?proxy=http://<server>/kp
	var pm = /[?&]proxy=([^&]+)/.exec(location.search);
	PROXY = pm ? decodeURIComponent(pm[1]) : 'http://localhost/kp';
}
var VERSION = '__VERSION__'; // filled in when the app is built
// Cloud build: the server keeps nothing, the TV holds its own Kinopub token.
var CLOUD = '__CLOUD__' === '1' || /[?&]cloud=1/.test(location.search);

var widgetAPI = (typeof Common !== 'undefined') ? new Common.API.Widget() : null;
var tvKey = (typeof Common !== 'undefined') ? new Common.API.TVKeyValue() : null;
var pluginAPI = (typeof Common !== 'undefined') ? new Common.API.Plugin() : null;

// Remote keys on the TV, keyboard keys in a desktop browser.
var K = tvKey ? {
	LEFT: tvKey.KEY_LEFT, RIGHT: tvKey.KEY_RIGHT, UP: tvKey.KEY_UP, DOWN: tvKey.KEY_DOWN,
	ENTER: tvKey.KEY_ENTER, RETURN: tvKey.KEY_RETURN, EXIT: tvKey.KEY_EXIT,
	PLAY: tvKey.KEY_PLAY, PAUSE: tvKey.KEY_PAUSE, STOP: tvKey.KEY_STOP,
	FF: tvKey.KEY_FF, RW: tvKey.KEY_RW, RED: tvKey.KEY_RED, GREEN: tvKey.KEY_GREEN,
	YELLOW: tvKey.KEY_YELLOW, BLUE: tvKey.KEY_BLUE,
	CH_UP: tvKey.KEY_CH_UP, CH_DOWN: tvKey.KEY_CH_DOWN, TOOLS: tvKey.KEY_TOOLS
} : {
	LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40, ENTER: 13, RETURN: 8, EXIT: 27,
	PLAY: 80, PAUSE: 32, STOP: 83, FF: 190, RW: 188, RED: 82, GREEN: 71,
	YELLOW: 89, BLUE: 66, CH_UP: 33, CH_DOWN: 34, TOOLS: 84
};

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(sec) {
	sec = Math.max(0, Math.floor(sec));
	var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
	return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
}
function shortTitle(t) { return String(t || '').split(' / ')[0]; }

// Moving focus only re-classes two elements: rebuilding a whole grid on every
// key press is the slowest thing this TV's CPU can be asked to do.
function setClass(id, cls, on) {
	var el = $(id);
	if (!el) return;
	var has = (' ' + el.className + ' ').indexOf(' ' + cls + ' ') >= 0;
	if (on && !has) el.className += ' ' + cls;
	else if (!on && has) el.className = (' ' + el.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
}
// Images added after the TV installed the app aren't in its files: the cloud
// build gets them from the Worker, which serves the repo's tv/img.
function imgUrl(name) { return CLOUD && PROXY.charAt(0) !== '_' ? PROXY + '/app/img/' + name : 'img/' + name; }

function moveFocus(from, to) { setClass(from, 'focus', false); setClass(to, 'focus', true); }

/* ---------- storage (cloud build keeps the token on the TV) ---------- */

// localStorage when the TV really persists it, else the Orsay FileSystem API.
var Store = {
	kind: null, fs: null, FILE: 'kptv.json', data: {},

	init: function () {
		try {
			window.localStorage.setItem('kp_probe', '1');
			if (window.localStorage.getItem('kp_probe') === '1') {
				Store.kind = 'ls';
				Store.data = JSON.parse(window.localStorage.getItem('kp_data') || '{}');
				return;
			}
		} catch (e) {}
		try {
			Store.fs = new FileSystem();
			var dir = curWidget.id;
			if (!Store.fs.isValidCommonPath(dir)) Store.fs.createCommonDir(dir);
			Store.FILE = dir + '/kptv.json';
			var f = Store.fs.openCommonFile(Store.FILE, 'r');
			if (f) { Store.data = JSON.parse(f.readAll() || '{}'); Store.fs.closeCommonFile(f); }
			Store.kind = 'fs';
		} catch (e2) { Store.kind = 'mem'; }
	},

	get: function (k) { return Store.data[k]; },

	set: function (k, v) {
		if (v === null || v === undefined) delete Store.data[k]; else Store.data[k] = v;
		var json = JSON.stringify(Store.data);
		try {
			if (Store.kind === 'ls') window.localStorage.setItem('kp_data', json);
			else if (Store.kind === 'fs') {
				var f = Store.fs.openCommonFile(Store.FILE, 'w');
				f.writeAll(json); Store.fs.closeCommonFile(f);
			}
		} catch (e) { Screen.log('store_error ' + Store.kind + ' ' + e); }
	}
};

/* ---------- network ---------- */

var Net = {
	// Cloud build: an expired token is refreshed once, then the request is retried.
	refreshing: null,
	refresh: function (done) {
		var tok = Store.get('token');
		if (!tok || !tok.refresh_token) { done(false); return; }
		if (Net.refreshing) { Net.refreshing.push(done); return; }
		Net.refreshing = [done];
		Net.raw('/auth/refresh?rt=' + encodeURIComponent(tok.refresh_token), function (status, data) {
			var ok = status === 200 && data && data.access_token;
			if (ok) Store.set('token', data);
			var cbs = Net.refreshing; Net.refreshing = null;
			for (var i = 0; i < cbs.length; i++) cbs[i](!!ok);
		});
	},

	raw: function (path, cb) {
		var xhr = new XMLHttpRequest();
		var done = false;
		var timer = setTimeout(function () { if (!done) { done = true; xhr.abort(); cb(0, null); } }, 20000);
		xhr.onreadystatechange = function () {
			if (xhr.readyState !== 4 || done) return;
			done = true; clearTimeout(timer);
			var data = null;
			try { data = JSON.parse(xhr.responseText); } catch (e) {}
			cb(xhr.status, data);
		};
		xhr.open('GET', PROXY + path, true);
		var tok = CLOUD && Store.get('token');
		if (tok) xhr.setRequestHeader('X-KP-Token', tok.access_token);
		xhr.send(null);
	},

	get: function (path, ok, fail, retried) {
		Net.raw(path, function (status, data) {
			if (status === 200 && data) ok(data);
			else if (status === 401 && CLOUD && !retried)
				Net.refresh(function (good) { if (good) Net.get(path, ok, fail, true); else App.showAuth(); });
			else if (status === 401) App.showAuth();
			else if (status === 0 && !retried && path.indexOf('_post=1') < 0) setTimeout(function () { Net.get(path, ok, fail, true); }, 1500);
			else if (status === 0) (fail || Net.fail)('Сервер не отвечает');
			else (fail || Net.fail)((data && data.error) ? data.error : 'Ошибка сети (' + status + ')');
		});
	},
	api: function (path, ok, fail) { Net.get('/api/' + path, ok, fail); },
	fail: function (msg) { UI.loading(false); UI.toast(msg); }
};

/* ---------- small UI helpers ---------- */

var UI = {
	toastTimer: null,
	toast: function (msg) {
		var t = $('toast');
		t.innerHTML = esc(msg); t.style.display = 'block';
		clearTimeout(UI.toastTimer);
		UI.toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3500);
	},
	toastPlayer: function (msg) {
		var t = $('playerToast');
		t.innerHTML = esc(msg); t.style.display = 'block';
		clearTimeout(UI.ptTimer);
		UI.ptTimer = setTimeout(function () { t.style.display = 'none'; }, 2500);
	},
	loading: function (on) { $('loading').style.display = on ? 'block' : 'none'; },
	screen: function (id) {
		var all = ['auth', 'home', 'item'];
		for (var i = 0; i < all.length; i++) $(all[i]).style.display = all[i] === id ? 'block' : 'none';
	}
};

/* ---------- screen fit ---------- */

// The UI is laid out natively at 960x540, the plane the 2013 Orsay TV renders
// apps in (scaling text with transforms made it ragged). Other window sizes
// (desktop testing) and the blue-key safe-area steps scale the whole UI.
var Screen = {
	USER: [1, 0.95, 0.9, 0.85, 0.8],
	w: 960, h: 540, user: 0,

	init: function () {
		var w = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
		var h = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
		Screen.reported = w + 'x' + h;
		if (tvKey) { w = 960; h = 540; } // the F-series renders apps in a 960x540 plane
		if (w > 100 && h > 100) { Screen.w = w; Screen.h = h; }
		try { var u = parseInt(window.localStorage.getItem('kp_zoom'), 10); if (u >= 0 && u < Screen.USER.length) Screen.user = u; } catch (e) {}
		Screen.apply();
	},

	apply: function () {
		var fit = Math.min(Screen.w / 960, Screen.h / 540);
		var s = fit * Screen.USER[Screen.user];
		var ox = Math.round((Screen.w - 960 * s) / 2), oy = Math.round((Screen.h - 540 * s) / 2);
		var r = $('root').style;
		var t = s === 1 ? 'none' : 'translate(' + ox + 'px,' + oy + 'px) scale(' + s + ')';
		r.webkitTransformOrigin = '0 0'; r.webkitTransform = t;
		r.transformOrigin = '0 0'; r.transform = t;
		document.body.style.width = Screen.w + 'px';
		document.body.style.height = Screen.h + 'px';
	},

	cycle: function () {
		Screen.user = (Screen.user + 1) % Screen.USER.length;
		try { window.localStorage.setItem('kp_zoom', String(Screen.user)); } catch (e) {}
		Screen.apply();
		var z = $('zoomInfo');
		z.innerHTML = 'Размер ' + Math.round(Screen.USER[Screen.user] * 100) + '%';
		z.style.display = 'block';
		clearTimeout(Screen.timer);
		Screen.timer = setTimeout(function () { z.style.display = 'none'; }, 1500);
	},

	// Errors go to the server log (docker logs / wrangler tail) for diagnosis.
	log: function (ev) {
		try { var x = new XMLHttpRequest(); x.open('GET', PROXY + '/log?v=' + VERSION + '&ev=' + encodeURIComponent(ev), true); x.send(null); } catch (e) {}
	}
};

/* ---------- auth ---------- */

var Auth = {
	timer: null,
	start: function () {
		UI.screen('auth');
		App.handler = Auth;
		$('authCode').innerHTML = '…';
		$('authHint').innerHTML = '';
		Net.get('/auth/start', function (r) {
			$('authCode').innerHTML = esc(r.user_code);
			$('authUrl').innerHTML = esc(String(r.verification_uri).replace(/^https?:\/\//, ''));
			$('authHint').innerHTML = 'Код действует ' + Math.round(r.expires_in / 60) + ' мин. Ждём подтверждения…';
			Auth.code = r.code || null;
			Auth.poll(+new Date() + r.expires_in * 1000, (r.interval || 5) * 1000);
		});
	},
	poll: function (deadline, every) {
		clearTimeout(Auth.timer);
		Auth.timer = setTimeout(function () {
			if (+new Date() > deadline) { Auth.start(); return; }
			Net.get('/auth/poll' + (CLOUD ? '?code=' + encodeURIComponent(Auth.code || '') : ''), function (r) {
				if (CLOUD && r.access_token) { Store.set('token', r); Home.open(); }
				else if (r.authorized) Home.open();
				else Auth.poll(deadline, every);
			}, function () { Auth.poll(deadline, every); });
		}, every);
	},
	key: function (k) { if (k === K.ENTER) Auth.start(); }
};

/* ---------- home: menu + poster grid + search ---------- */

var SORTS = [{ id: '-created', title: 'новые' }, { id: '-views', title: 'популярные' }, { id: '-rating', title: 'лучшие' }];

// "Главная": the shelves Kinopub's own front page shows.
var SHELVES = [
	// unfinished films and series: OK resumes right away
	{ title: 'Продолжить просмотр', cont: true, recs: true, badge: 'new' },
	// taken in turns from the film / series / anime shelves of "Для тебя"
	{ title: 'Для тебя', recs: true, mix: ['movie', 'serial', 'anime'] },
	{ title: 'Популярные фильмы', path: 'items/popular?type=movie' },
	{ title: 'Новые фильмы', path: 'items/fresh?type=movie' },
	{ title: 'Популярные сериалы', path: 'items/popular?type=serial' },
	{ title: 'Новые сериалы', path: 'items/fresh?type=serial' },
	{ title: 'Горячие фильмы', path: 'items/hot?type=movie' },
	{ title: 'Горячие сериалы', path: 'items/hot?type=serial' },
	{ title: 'Новые концерты', path: 'items/fresh?type=concert' },
	{ title: 'Новые документальные', path: 'items/fresh?type=documovie' }
];

// "Для тебя": one shelf per category, each recommended from what was watched in it
var REC_SHELVES = [
	{ title: 'Новинки для тебя', recs: 'new' },
	{ title: 'Фильмы', recs: 'movie' },
	{ title: 'Сериалы', recs: 'serial' },
	{ title: 'Аниме', recs: 'anime' },
	{ title: 'Концерты', recs: 'concert' },
	{ title: 'Документальное', recs: 'doc' }
];

// icon = position in img/menu-*.png
var SECTIONS = [
	{ title: 'Главная', shelves: true, icon: 0 },
	{ title: 'Для тебя', recs: true, shelves: REC_SHELVES, icon: 13 },
	{ title: 'Новинки', list: '', icon: 1 },
	{ title: 'Фильмы', list: 'type=movie', icon: 2 },
	{ title: 'Сериалы', list: 'type=serial', icon: 3 },
	{ title: 'Аниме', list: 'genre=25', icon: 4 },
	{ title: 'Концерты', list: 'type=concert', icon: 5 },
	{ title: 'Докуфильмы', list: 'type=documovie', icon: 6 },
	{ title: 'Докусериалы', list: 'type=docuserial', icon: 7 },
	{ title: 'ТВ-шоу', list: 'type=tvshow', icon: 8 },
	{ title: 'История', history: true, icon: 10 },
	{ title: 'Закладки', bookmarks: true, icon: 11 },
	{ title: 'Поиск', search: true, icon: 12 }
];

// Recommendations come from the cloud Worker (TMDB); the local proxy has none.
if (!CLOUD) {
	for (var si = SECTIONS.length - 1; si >= 0; si--) if (SECTIONS[si].recs) SECTIONS.splice(si, 1);
	for (var sj = SHELVES.length - 1; sj >= 0; sj--) if (SHELVES[sj].recs) SHELVES.splice(sj, 1);
}

var COLS = 6, ROWS = 2, CW = 124, RH = 219, SH = 236;

// Kinopub streams from Russia or the Netherlands; the choice is a setting of
// this device on Kinopub (ids from device/info: 3 = Россия, 1 = Нидерланды).
var SERVERS = [{ id: 3, title: 'Россия', cls: 'ru' }, { id: 1, title: 'Нидерланды', cls: 'nl' }];

// Same rows as a Mac keyboard: digits on top, then ЙЦУКЕН / QWERTY.
var KB = {
	ru: [
		['1','2','3','4','5','6','7','8','9','0'],
		['й','ц','у','к','е','н','г','ш','щ','з','х','ъ'],
		['ф','ы','в','а','п','р','о','л','д','ж','э','ё'],
		['я','ч','с','м','и','т','ь','б','ю']
	],
	en: [
		['1','2','3','4','5','6','7','8','9','0'],
		['q','w','e','r','t','y','u','i','o','p'],
		['a','s','d','f','g','h','j','k','l'],
		['z','x','c','v','b','n','m']
	]
};

var Home = {
	sec: 0,           // selected menu section
	area: 'menu',     // menu | grid | kb
	items: [], page: 0, pages: 1, loadingMore: false,
	idx: 0, top: 0,   // focused card, first visible row
	query: '', lang: 'ru', kbRow: 1, kbCol: 0, kbRows: [], searchTimer: null, reqId: 0,
	sorts: {}, folder: null, seen: {}, inited: false,
	cache: {}, loadTimer: null,

	open: function () {
		UI.screen('home');
		App.handler = Home;
		Home.renderMenu();
		if (!Home.inited) { Home.inited = true; Home.load(Home.sec); Home.loadServer(); }
		else {
			if (SECTIONS[Home.sec].shelves) Shelf.ensure(); // e.g. "Продолжить" after watching
			Home.renderGrid();
		}
	},

	sortIdx: function () { return Home.sorts[Home.sec] || 0; },

	renderTitle: function () {
		var s = SECTIONS[Home.sec];
		var h = esc(s.title) + (Home.folder ? ' · ' + esc(Home.folder.title) : '');
		if (Home.folder) h += '<span class="hint">RETURN — к папкам</span>';
		else {
			var legend = '<span class="k red"></span> поиск <span class="k green"></span> новинки' +
				(Home.find('recs') >= 0 ? ' <span class="k yellow"></span> для тебя' : '');
			if (s.list !== undefined) legend += ' <span class="k blue"></span> ' + SORTS[Home.sortIdx()].title;
			// attribution required by TMDB's terms
			if (s.recs) legend = 'рекомендации <img class="tmdb" src="' + imgUrl('tmdb.png') + '" alt="TMDB" /> &nbsp; ' + legend;
			h += '<span class="hint">' + legend + '</span>';
		}
		$('sectionTitle').innerHTML = h;
	},

	renderMenu: function () {
		var h = '<div class="logo"><img src="img/logo-24.png" alt="" />kinopub <span class="ver">v' + VERSION + (CLOUD ? '' : 'L') + '</span></div>';
		for (var i = 0; i < SECTIONS.length; i++) {
			var c = 'mi' + (i === Home.sec ? ' active' : '') + (Home.area === 'menu' && i === Home.sec ? ' focus' : '');
			h += '<div id="mi' + i + '" class="' + c + '"><span class="ico" style="background-position:-' + (SECTIONS[i].icon * 16) + 'px 0"></span>' + esc(SECTIONS[i].title) + '</div>';
		}
		h += '<div class="srv">';
		for (var j = 0; j < SERVERS.length; j++) {
			var sv = SERVERS[j];
			h += '<span id="srv' + sv.id + '" class="flag ' + sv.cls + (sv.id === Home.server ? ' sel' : '') +
				(Home.area === 'servers' && j === Home.srvIdx ? ' focus' : '') + '"><i></i><i></i><i></i></span>';
		}
		var cur = Home.area === 'servers' ? SERVERS[Home.srvIdx] : Home.serverInfo();
		h += '<div class="srv-label">' + (cur ? 'Сервер: ' + esc(cur.title) : '') + '</div></div>';
		$('menu').innerHTML = h;
	},

	server: null, srvIdx: 0, deviceId: null,
	serverInfo: function () {
		for (var i = 0; i < SERVERS.length; i++) if (SERVERS[i].id === Home.server) return SERVERS[i];
		return null;
	},
	loadServer: function () {
		Net.api('device/info', function (r) {
			var d = r.device || {}, list = (d.settings && d.settings.serverLocation && d.settings.serverLocation.value) || [];
			Home.deviceId = d.id;
			for (var i = 0; i < list.length; i++) if (list[i].selected) Home.server = list[i].id;
			if (App.handler === Home) Home.renderMenu();
		}, function () {});
	},
	pickServer: function (sv) {
		if (!Home.deviceId) { UI.toast('Не удалось узнать устройство'); return; }
		if (sv.id === Home.server) { UI.toast('Уже смотрим через: ' + sv.title); return; }
		Net.api('device/' + Home.deviceId + '/settings?_post=1&serverLocation=' + sv.id, function () {
			Home.server = sv.id;
			Home.renderMenu();
			UI.toast('Сервер: ' + sv.title + '. Заработает со следующего фильма');
		});
	},

	// Walking through the menu only moves the highlight; a section loads once
	// the user stays on it, or right away if it was opened recently.
	browse: function (sec) {
		var old = Home.sec;
		setClass('mi' + old, 'focus', false); setClass('mi' + old, 'active', false);
		setClass('mi' + sec, 'focus', true); setClass('mi' + sec, 'active', true);
		Home.sec = sec;
		Home.reqId++;
		clearTimeout(Home.loadTimer); Home.loadTimer = null;
		if (Home.fromCache(sec)) return;
		Home.folder = null;
		Home.renderTitle();
		$('home').className = 'screen' + (SECTIONS[sec].search ? ' search' : '');
		$('searchBox').style.display = 'none';
		$('grid').innerHTML = ''; $('gridEmpty').innerHTML = '';
		Home.loadTimer = setTimeout(function () { Home.loadTimer = null; Home.load(sec); }, 350);
	},

	cacheKey: function (sec) { return sec + '|' + (Home.sorts[sec] || 0); },

	// Lists stay fresh for 5 minutes, history for 1.
	fromCache: function (sec) {
		var s = SECTIONS[sec], c = Home.cache[Home.cacheKey(sec)];
		if (!c || s.search || (Home.folder && sec === Home.sec)) return false;
		var ttl = s.history ? 60000 : 300000;
		if (+new Date() - c.ts > ttl) return false;
		Home.sec = sec; Home.folder = null; Home.seen = {};
		if (c.items) for (var si2 = 0; si2 < c.items.length; si2++) Home.seen[c.items[si2].id] = true; // History pages after it
		Home.reqId++; Home.loadingMore = false; UI.loading(false);
		Home.renderTitle();
		$('home').className = 'screen';
		$('searchBox').style.display = 'none';
		Home.idx = 0; Home.top = 0;
		if (s.shelves) {
			Shelf.rows = c.rows; Shelf.si = 0; Shelf.top = 0;
			for (var i = 0; i < c.rows.length; i++) { c.rows[i].idx = 0; c.rows[i].off = 0; }
			Shelf.ensure();
		}
		else { Home.items = c.items.slice(0); Home.page = c.page; Home.pages = c.pages; }
		Home.renderGrid();
		return true;
	},

	remember: function () {
		var s = SECTIONS[Home.sec];
		if (s.search || Home.folder) return;
		// at most two pages per list, so a long evening in History doesn't eat the TV's memory
		var page = Math.min(Home.page, 2);
		Home.cache[Home.cacheKey(Home.sec)] = s.shelves ? { rows: Shelf.rows, ts: +new Date() }
			: { items: Home.items.slice(0, page * 30), page: page, pages: Home.pages, ts: +new Date() };
	},

	load: function (sec, keepFolder) {
		if (!keepFolder && Home.fromCache(sec)) return;
		if (sec !== Home.sec || !keepFolder) Home.folder = null;
		Home.sec = sec;
		Home.seen = {};
		Home.items = []; Home.page = 0; Home.pages = 1; Home.idx = 0; Home.top = 0;
		Home.loadingMore = false; Home.reqId++; // drop answers for the previous section
		UI.loading(false);
		var s = SECTIONS[sec];
		Home.renderTitle();
		$('home').className = 'screen' + (s.search ? ' search' : '');
		$('searchBox').style.display = s.search ? 'block' : 'none';
		$('grid').innerHTML = '';
		$('gridEmpty').innerHTML = '';
		if (s.search) { Home.renderKb(); Home.doSearch(); return; }
		if (s.shelves) { Shelf.load(); return; }
		Home.more();
	},

	// What to fetch for page `page` of the current section, and how to read the answer.
	request: function (page) {
		var s = SECTIONS[Home.sec];
		if (s.list !== undefined)
			return { path: 'items?' + (s.list ? s.list + '&' : '') + 'sort=' + SORTS[Home.sortIdx()].id + '&perpage=30&page=' + page,
				parse: function (r) { return r.items || []; } };
		if (s.history)
			return { path: 'history?perpage=30&page=' + page, parse: function (r) {
				var out = [], h = r.history || [];
				for (var i = 0; i < h.length; i++) {
					var it = h[i].item;
					if (it && !Home.seen[it.id]) { Home.seen[it.id] = true; out.push(it); }
				}
				return out;
			} };
		if (s.bookmarks && Home.folder)
			return { path: 'bookmarks/' + Home.folder.id + '?perpage=30&page=' + page, parse: function (r) { return r.items || []; } };
		if (s.bookmarks)
			return { path: 'bookmarks', parse: function (r) {
				var out = [], f = r.items || [];
				for (var i = 0; i < f.length; i++) out.push({ folder: true, id: f[i].id, title: f[i].title, count: f[i].count });
				return out;
			} };
		return null;
	},

	more: function () {
		var s = SECTIONS[Home.sec];
		if (s.search || Home.loadingMore || Home.page >= Home.pages) return;
		Home.loadingMore = true;
		var id = ++Home.reqId;
		if (!Home.items.length) UI.loading(true);
		var fail = function (msg) { Home.loadingMore = false; Net.fail(msg); };
		var done = function (items, pag) {
			if (id !== Home.reqId) return;
			Home.loadingMore = false;
			UI.loading(false);
			Home.items = Home.items.concat(items);
			if (pag) { Home.page = pag.current; Home.pages = pag.total; }
			else { Home.page = 1; Home.pages = 1; }
			Home.remember();
			Home.renderGrid();
		};
		var req = Home.request(Home.page + 1);
		Net.api(req.path, function (r) { done(req.parse(r), r.pagination || null); }, fail);
	},

	doSearch: function () {
		var id = ++Home.reqId;
		$('searchQuery').innerHTML = esc(Home.query) + '<span style="color:#02b875">|</span>';
		if (Home.query.length < 2) {
			Home.items = []; Home.renderGrid();
			$('gridEmpty').innerHTML = 'Набери название пультом';
			return;
		}
		var got = function (r) {
			if (id !== Home.reqId) return;
			Home.items = r.items || []; Home.idx = 0; Home.top = 0;
			Home.page = 1; Home.pages = 1;
			Home.renderGrid();
		};
		if (CLOUD) Net.get('/search?q=' + encodeURIComponent(Home.query), got);
		else Net.api('items/search?perpage=30&q=' + encodeURIComponent(Home.query), got);
	},

	rows: function () { return SECTIONS[Home.sec].search ? 1 : ROWS; },

	renderGrid: function () {
		if (SECTIONS[Home.sec].shelves) { Shelf.render(); return; }
		var rows = Home.rows();
		var h = '';
		var from = Home.top * COLS, to = Math.min(Home.items.length, from + (rows + 1) * COLS);
		for (var i = from; i < to; i++) {
			var it = Home.items[i];
			var r = Math.floor(i / COLS) - Home.top, c = i % COLS;
			h += cardHtml('g' + i, it, Home.area === 'grid' && i === Home.idx, c * CW, r * RH);
		}
		$('grid').innerHTML = h;
		$('gridEmpty').innerHTML = Home.items.length ? '' : (SECTIONS[Home.sec].search ? (Home.query.length < 2 ? 'Набери название пультом' : 'Ничего не нашлось') : 'Пусто');
	},

	renderKb: function () {
		var rows = KB[Home.lang], out = [];
		for (var r = 0; r < rows.length; r++) {
			var row = [];
			for (var c = 0; c < rows[r].length; c++) row.push({ id: 'ch', ch: rows[r][c], label: rows[r][c].toUpperCase() });
			out.push(row);
		}
		out.push([{ id: 'lang', label: Home.lang === 'ru' ? 'ENG' : 'РУС' }, { id: 'space', label: 'Пробел', cls: ' space' },
			{ id: 'back', label: '← Стереть' }, { id: 'clear', label: 'Очистить' }]);
		Home.kbRows = out;
		if (Home.kbRow >= out.length) Home.kbRow = out.length - 1;
		if (Home.kbCol >= out[Home.kbRow].length) Home.kbCol = out[Home.kbRow].length - 1;
		var h = '';
		for (var i = 0; i < out.length; i++) {
			// stagger rows like a real keyboard
			h += '<div class="kr" style="padding-left:' + (i === 0 || i === out.length - 1 ? 0 : i * 16) + 'px">';
			for (var j = 0; j < out[i].length; j++) {
				var kk = out[i][j];
				h += '<div id="k' + i + '_' + j + '" class="kk' + (kk.id !== 'ch' ? ' wide' : '') + (kk.cls || '') +
					(Home.area === 'kb' && i === Home.kbRow && j === Home.kbCol ? ' focus' : '') + '">' + esc(kk.label) + '</div>';
			}
			h += '</div>';
		}
		$('keyboard').innerHTML = h;
	},

	kbPress: function () {
		var kk = Home.kbRows[Home.kbRow][Home.kbCol];
		if (kk.id === 'ch') Home.query += kk.ch;
		else if (kk.id === 'space') Home.query += ' ';
		else if (kk.id === 'back') Home.query = Home.query.slice(0, -1);
		else if (kk.id === 'clear') Home.query = '';
		else if (kk.id === 'lang') { Home.lang = Home.lang === 'ru' ? 'en' : 'ru'; Home.renderKb(); }
		$('searchQuery').innerHTML = esc(Home.query) + '<span style="color:#02b875">|</span>';
		clearTimeout(Home.searchTimer);
		Home.searchTimer = setTimeout(Home.doSearch, 700);
	},

	// Move to another keyboard row, keeping roughly the same horizontal spot.
	kbVert: function (d) {
		var from = Home.kbRows[Home.kbRow], to = Home.kbRows[Home.kbRow + d];
		var frac = from.length > 1 ? Home.kbCol / (from.length - 1) : 0;
		Home.kbRow += d;
		Home.kbCol = Math.round(frac * (to.length - 1));
	},

	cycleSort: function () {
		Home.sorts[Home.sec] = (Home.sortIdx() + 1) % SORTS.length;
		var area = Home.area;
		Home.load(Home.sec);
		Home.area = area;
	},

	moveGrid: function (d) {
		var n = Home.items.length;
		if (!n) return;
		var i = Home.idx + d;
		if (d === -1 && Home.idx % COLS === 0) { Home.area = 'menu'; Home.renderMenu(); Home.renderGrid(); return; }
		if (i < 0) {
			if (SECTIONS[Home.sec].search) { Home.area = 'kb'; Home.renderKb(); Home.renderGrid(); }
			return;
		}
		if (i >= n) {
			if (d === COLS && Math.floor(Home.idx / COLS) < Math.floor((n - 1) / COLS)) i = n - 1;
			else return;
		}
		if (d === 1 && i % COLS === 0) return;
		var old = Home.idx, oldTop = Home.top;
		Home.idx = i;
		var row = Math.floor(i / COLS), rows = Home.rows();
		if (row < Home.top) Home.top = row;
		if (row >= Home.top + rows) Home.top = row - rows + 1;
		if (n - i <= COLS * 2) Home.more();
		if (Home.top === oldTop) moveFocus('g' + old, 'g' + i);
		else Home.renderGrid();
	},

	// Index of the first section with the given flag, e.g. 'search'.
	find: function (flag) {
		for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i][flag] !== undefined) return i;
		return -1;
	},

	// Colour keys jump to Search / New / For you from anywhere on the home screen.
	jump: function (flag) {
		var to = Home.find(flag);
		if (to < 0) return;
		clearTimeout(Home.loadTimer); Home.loadTimer = null;
		Home.area = SECTIONS[to].search ? 'kb' : 'grid';
		if (to !== Home.sec || Home.folder) Home.load(to);
		Home.renderMenu();
		Home.renderGrid();
		if (SECTIONS[to].search) Home.renderKb();
	},

	key: function (k) {
		var s = SECTIONS[Home.sec];
		if (k === K.RED) { if (!s.search) Home.jump('search'); return; }
		if (k === K.GREEN) { Home.jump('list'); return; }
		if (k === K.YELLOW) { Home.jump('recs'); return; }
		if (k === K.BLUE) { if (s.list !== undefined) Home.cycleSort(); return; }
		if (Home.area === 'menu') {
			// the menu wraps around: up from the top lands on Search, down from Search on the top
			// ... → Поиск → server flags → Главная → ...
			var n = SECTIONS.length;
			if ((k === K.UP && Home.sec === 0) || (k === K.DOWN && Home.sec === n - 1)) {
				Home.area = 'servers';
				Home.srvIdx = 0;
				for (var si = 0; si < SERVERS.length; si++) if (SERVERS[si].id === Home.server) Home.srvIdx = si;
				Home.renderMenu();
			}
			else if (k === K.UP) Home.browse(Home.sec - 1);
			else if (k === K.DOWN) Home.browse(Home.sec + 1);
			else if (k === K.RIGHT || k === K.ENTER) {
				if (Home.loadTimer) { clearTimeout(Home.loadTimer); Home.loadTimer = null; Home.load(Home.sec); }
				if (s.search) { Home.area = 'kb'; Home.renderKb(); }
				else if (Home.items.length || (s.shelves && Shelf.rows.length)) { Home.area = 'grid'; Home.renderGrid(); }
				Home.renderMenu();
			}
			return;
		}
		if (Home.area === 'servers') {
			if (k === K.LEFT && Home.srvIdx > 0) Home.srvIdx--;
			else if (k === K.RIGHT && Home.srvIdx < SERVERS.length - 1) Home.srvIdx++;
			else if (k === K.ENTER) { Home.pickServer(SERVERS[Home.srvIdx]); return; }
			else if (k === K.UP || k === K.DOWN) {
				Home.area = 'menu';
				Home.browse(k === K.UP ? SECTIONS.length - 1 : 0);
				Home.renderMenu();
				return;
			}
			Home.renderMenu();
			return;
		}
		if (Home.area === 'kb') {
			var rowsN = Home.kbRows.length, rowLen = Home.kbRows[Home.kbRow].length;
			var oKey = 'k' + Home.kbRow + '_' + Home.kbCol;
			if (k === K.LEFT) { if (Home.kbCol === 0) { Home.area = 'menu'; Home.renderMenu(); } else Home.kbCol--; }
			else if (k === K.RIGHT) { if (Home.kbCol < rowLen - 1) Home.kbCol++; }
			else if (k === K.UP) { if (Home.kbRow > 0) Home.kbVert(-1); }
			else if (k === K.DOWN) {
				if (Home.kbRow < rowsN - 1) Home.kbVert(1);
				else if (Home.items.length) { Home.area = 'grid'; Home.idx = 0; Home.top = 0; Home.renderGrid(); }
			}
			else if (k === K.ENTER) { Home.kbPress(); return; }
			else if (k === K.RETURN) {
				// Return erases a letter; on an empty query it goes back to the menu.
				if (!Home.query) { Home.area = 'menu'; Home.renderMenu(); }
				else {
					Home.query = Home.query.slice(0, -1);
					clearTimeout(Home.searchTimer);
					Home.searchTimer = setTimeout(Home.doSearch, 700);
					$('searchQuery').innerHTML = esc(Home.query) + '<span style="color:#02b875">|</span>';
				}
			}
			if (Home.area === 'kb') moveFocus(oKey, 'k' + Home.kbRow + '_' + Home.kbCol);
			else setClass(oKey, 'focus', false);
			return;
		}
		if (s.shelves) { Shelf.key(k); return; }
		if (k === K.RETURN && Home.folder) { Home.folder = null; Home.load(Home.sec); Home.area = 'grid'; return; }
		// grid
		if (k === K.LEFT) Home.moveGrid(-1);
		else if (k === K.RIGHT) Home.moveGrid(1);
		else if (k === K.UP) Home.moveGrid(-COLS);
		else if (k === K.DOWN) Home.moveGrid(COLS);
		else if (k === K.CH_DOWN) Home.moveGrid(COLS * 2);
		else if (k === K.CH_UP) Home.moveGrid(-COLS * 2);
		else if (k === K.RETURN) { Home.area = s.search ? 'kb' : 'menu'; Home.renderMenu(); Home.renderGrid(); if (s.search) Home.renderKb(); }
		else if (k === K.ENTER && Home.items[Home.idx]) {
			var it = Home.items[Home.idx];
			if (it.folder) { Home.folder = it; Home.load(Home.sec, true); }
			else Item.open(it.id);
		}
	}
};

function cardHtml(id, it, focus, x, y, badgeKind) {
	var body;
	if (it.folder) body = '<div class="pw folder"><div class="ft">' + esc(it.title) + '</div><div class="fc">' + (it.count || 0) + '</div></div><div class="t"></div>';
	else body = '<div class="pw"><img src="' + esc(it.posters ? it.posters.small : '') + '" /></div>' +
		(badgeKind === 'new' && it['new'] ? '<div class="badge">+' + it['new'] + '</div>' : '') +
		'<div class="t">' + esc(shortTitle(it.title)) + '</div>';
	return '<div id="' + id + '" class="card' + (focus ? ' focus' : '') + '" style="left:' + x + 'px;top:' + y + 'px">' + body + '</div>';
}

/* ---------- "Главная": horizontal shelves ---------- */

var Shelf = {
	rows: [], si: 0, top: 0,

	load: function () {
		Shelf.rows = []; Shelf.si = 0; Shelf.top = 0;
		var list = SECTIONS[Home.sec].shelves;
		if (!(list instanceof Array)) list = SHELVES;
		for (var i = 0; i < list.length; i++)
			Shelf.rows.push({ title: list[i].title, def: list[i], items: [], idx: 0, off: 0, state: 'idle' });
		UI.loading(true);
		Shelf.ensure();
	},

	// Load the rows on screen and the next one; the rest wait until scrolled to.
	ensure: function () {
		for (var r = Shelf.top; r < Shelf.rows.length && r < Shelf.top + 3; r++) Shelf.fetch(Shelf.rows[r]);
	},

	fetch: function (row) {
		if (row.state !== 'idle') return;
		row.state = 'loading';
		var id = Home.reqId, sh = row.def;
		var got = function (r) {
			if (id !== Home.reqId) { row.state = 'idle'; return; } // section left meanwhile
			UI.loading(false);
			row.items = r.items || [];
			row.state = 'done';
			Home.remember();
			Shelf.later();
		};
		var failed = function () { row.state = id === Home.reqId ? 'done' : 'idle'; if (id === Home.reqId) { UI.loading(false); Shelf.later(); } };
		if (sh.cont) Net.get('/continue', got, failed);
		else if (sh.mix) Shelf.mix(sh.mix, got);
		else if (sh.recs) Net.get('/recs?cat=' + sh.recs, got, failed);
		else Net.api(sh.path + '&perpage=24', got, failed);
	},

	// Several rows arriving together are drawn once.
	later: function () {
		if (Shelf.timer) return;
		Shelf.timer = setTimeout(function () { Shelf.timer = null; Shelf.prune(); if (Home.sec >= 0 && SECTIONS[Home.sec].shelves) Shelf.render(); }, 40);
	},

	staleContinue: function () {
		var all = [Shelf.rows];
		for (var k in Home.cache) if (Home.cache[k].rows) all.push(Home.cache[k].rows);
		for (var a = 0; a < all.length; a++)
			for (var r = 0; r < all[a].length; r++) if (all[a][r].def && all[a][r].def.cont) all[a][r].state = 'idle';
	},

	// Rows that came back empty are dropped so the focus never lands on nothing.
	prune: function () {
		for (var r = Shelf.rows.length - 1; r >= 0; r--) {
			if (Shelf.rows[r].state !== 'done' || Shelf.rows[r].items.length) continue;
			Shelf.rows.splice(r, 1);
			if (Shelf.si > r || Shelf.si >= Shelf.rows.length) Shelf.si = Math.max(0, Shelf.si - 1);
			if (Shelf.top > r || Shelf.top >= Shelf.rows.length) Shelf.top = Math.max(0, Shelf.top - 1);
		}
	},

	// Fetch several recommendation categories and interleave them: film, series, anime, film, ...
	mix: function (cats, done) {
		var lists = [], left = cats.length;
		var finish = function () {
			if (--left > 0) return;
			var out = [], seen = {};
			for (var i = 0; out.length < 24; i++) {
				var any = false;
				for (var c = 0; c < lists.length; c++) {
					var it = lists[c] && lists[c][i];
					if (!it) continue;
					any = true;
					if (!seen[it.id]) { seen[it.id] = true; out.push(it); }
				}
				if (!any) break;
			}
			done({ items: out });
		};
		for (var c = 0; c < cats.length; c++) (function (c) {
			Net.get('/recs?cat=' + cats[c], function (r) { lists[c] = r.items || []; finish(); }, function () { finish(); });
		})(c);
	},

	render: function () {
		var h = '', focus = Home.area === 'grid';
		for (var r = Shelf.top; r < Shelf.rows.length && r < Shelf.top + 2; r++) {
			var row = Shelf.rows[r], y = (r - Shelf.top) * SH;
			var credit = row.def && row.def.mix ? ' <img class="tmdb" src="' + imgUrl('tmdb.png') + '" alt="TMDB" />' : ''; // TMDB's terms
			h += '<div id="st' + r + '" class="shelf-t' + (focus && r === Shelf.si ? ' active' : '') + '" style="top:' + y + 'px">' + esc(row.title) + credit + '</div>';
			for (var i = row.off; i < row.items.length && i < row.off + COLS; i++)
				h += cardHtml('s' + r + '_' + i, row.items[i], focus && r === Shelf.si && i === row.idx, (i - row.off) * CW, y + 28, row.def && row.def.badge);
		}
		$('grid').innerHTML = h;
		$('gridEmpty').innerHTML = '';
	},

	key: function (k) {
		var row = Shelf.rows[Shelf.si];
		if (!row) { if (k === K.LEFT || k === K.RETURN) { Home.area = 'menu'; Home.renderMenu(); } return; }
		var oSi = Shelf.si, oTop = Shelf.top, oIdx = row.idx, oOff = row.off;
		if (k === K.LEFT) {
			if (row.idx > 0) { row.idx--; if (row.idx < row.off) row.off = row.idx; }
			else { Home.area = 'menu'; Home.renderMenu(); }
		}
		else if (k === K.RIGHT && row.idx < row.items.length - 1) { row.idx++; if (row.idx >= row.off + COLS) row.off = row.idx - COLS + 1; }
		else if (k === K.UP && Shelf.si > 0) { Shelf.si--; if (Shelf.si < Shelf.top) Shelf.top = Shelf.si; }
		else if (k === K.DOWN && Shelf.si < Shelf.rows.length - 1) { Shelf.si++; if (Shelf.si > Shelf.top + 1) Shelf.top = Shelf.si - 1; }
		else if (k === K.RETURN) { Home.area = 'menu'; Home.renderMenu(); }
		else if (k === K.ENTER && row.items[row.idx]) { Item.open(row.items[row.idx].id, false, !!(row.def && row.def.cont)); return; }
		if (Shelf.top !== oTop) Shelf.ensure();
		if (Home.area !== 'grid') { setClass('s' + oSi + '_' + oIdx, 'focus', false); setClass('st' + oSi, 'active', false); return; }
		// redraw only when the visible window scrolled
		if (Shelf.top !== oTop || row.off !== oOff) { Shelf.render(); return; }
		moveFocus('s' + oSi + '_' + oIdx, 's' + Shelf.si + '_' + Shelf.rows[Shelf.si].idx);
		if (Shelf.si !== oSi) { setClass('st' + oSi, 'active', false); setClass('st' + Shelf.si, 'active', true); }
	}
};

/* ---------- item page: seasons + episodes ---------- */

var QUALITIES = ['1080p', '720p', '480p'];

var Item = {
	data: null, seasons: [], si: 0, ei: 0, top: 0, area: 'episodes',
	quality: 0, VISIBLE: 7, act: 0,

	open: function (id, keepPos, autoplay) {
		UI.loading(true);
		// the cloud build gets a page without per-episode media (a long series is megabytes otherwise)
		var load = CLOUD ? function (ok) { Net.get('/item?id=' + id + '&srv=' + (Home.server || 0), ok); } : function (ok) { Net.api('items/' + id, ok); };
		load(function (r) {
			UI.loading(false);
			var it = r.item;
			var prev = Item.data && Item.data.id === it.id && keepPos;
			Item.data = it;
			Item.seasons = [];
			if (it.seasons && it.seasons.length) {
				for (var i = 0; i < it.seasons.length; i++) Item.seasons.push({ title: 'Сезон ' + it.seasons[i].number, number: it.seasons[i].number, eps: it.seasons[i].episodes || [] });
			} else {
				Item.seasons.push({ title: '', number: 0, eps: it.videos || [] });
			}
			if (!prev) Item.pickStart();
			Item.act = 0;
			if (!prev) Item.checkToWatch(it.id);
			Item.area = 'episodes';
			Item.onTrailer = false;
			Item.tabOff = 0;
			UI.screen('item');
			App.handler = Item;
			Item.renderStatic();
			Item.render();
			// "Продолжить просмотр": straight into the player where it stopped
			if (autoplay) Item.play(false);
		});
	},

	// Land on the first episode that isn't finished.
	pickStart: function () {
		Item.si = 0; Item.ei = 0; Item.top = 0;
		for (var s = 0; s < Item.seasons.length; s++) {
			var eps = Item.seasons[s].eps;
			for (var e = 0; e < eps.length; e++) {
				var st = eps[e].watching ? eps[e].watching.status : eps[e].watched;
				if (st !== 1) { Item.si = s; Item.ei = e; Item.scroll(); return; }
			}
		}
	},

	scroll: function () {
		if (Item.ei < Item.top) Item.top = Item.ei;
		if (Item.ei >= Item.top + Item.VISIBLE) Item.top = Item.ei - Item.VISIBLE + 1;
	},

	// What doesn't change while moving around the page: drawn once per open.
	renderStatic: function () {
		var it = Item.data;
		$('itemPoster').src = it.posters ? it.posters.medium : '';
		$('itemTitle').innerHTML = esc(it.title);
		var meta = [];
		if (it.year) meta.push(it.year);
		if (it.countries && it.countries.length) meta.push(it.countries[0].title);
		var g = []; for (var i = 0; it.genres && i < it.genres.length && i < 3; i++) g.push(it.genres[i].title);
		if (g.length) meta.push(g.join(', '));
		if (it.kinopoisk_rating) meta.push('КП ' + (+it.kinopoisk_rating).toFixed(1));
		if (it.imdb_rating) meta.push('IMDb ' + (+it.imdb_rating).toFixed(1));
		$('itemMeta').innerHTML = esc(meta.join('  ·  '));
		$('itemPlot').innerHTML = esc(it.plot);
		Item.renderHints();
	},

	render: function () {
		var multi = Item.seasons.length > 1 || Item.seasons[0].number > 0;
		var h = '';
		if (multi) {
			// series tabs: "▶ Трейлер", Сезон 1, Сезон 2, ... — a window that follows the focus
			var tabs = Item.tabs(), fi = Item.tabIndex(), tabsFocus = Item.area === 'seasons';
			if (fi < Item.tabOff) Item.tabOff = fi;
			if (fi >= Item.tabOff + Item.TABS) Item.tabOff = fi - Item.TABS + 1;
			if (Item.tabOff > 0) h += '<span class="st-more">&#8249;</span>';
			for (var t = Item.tabOff; t < tabs.length && t < Item.tabOff + Item.TABS; t++) {
				var tab = tabs[t], on = t === fi;
				h += '<span class="st' + (tab.trailer ? ' trailer' : '') + (on && !tab.trailer ? ' active' : '') + (tabsFocus && on ? ' focus' : '') + '">' +
					(tab.trailer ? '&#9654; Трейлер' : esc(Item.seasons[tab.season].title)) + '</span>';
			}
			if (Item.tabOff + Item.TABS < tabs.length) h += '<span class="st-more">&#8250;</span>';
		}
		$('seasons').innerHTML = h;
		$('seasons').style.display = multi ? 'block' : 'none';

		var eps = Item.seasons[Item.si].eps;
		h = '';
		if (Item.single()) {
			var acts = Item.actions();
			for (var a = 0; a < acts.length; a++)
				h += '<div class="ep' + (Item.area === 'episodes' && a === Item.act ? ' focus' : '') + '">' + esc(acts[a].label) +
					'<span class="d">' + (a === 0 && eps[0].duration ? fmtTime(eps[0].duration) : '') + '</span></div>';
			$('episodes').innerHTML = h;
			return;
		}
		for (var e = Item.top; e < eps.length && e < Item.top + Item.VISIBLE; e++) {
			var ep = eps[e];
			var w = ep.watching || { status: ep.watched, time: 0 };
			var label, num;
			if (multi) { num = ep.number; label = ep.title || ('Серия ' + ep.number); }
			else { num = ''; label = eps.length > 1 ? ('Часть ' + ep.number + (ep.title ? ': ' + ep.title : '')) : 'Смотреть'; }
			var right = '';
			if (w.status === 0 && w.time > 0) label = (eps.length > 1 || multi ? label + ' — продолжить' : 'Продолжить') + ' с ' + fmtTime(w.time);
			if (ep.duration) right = fmtTime(ep.duration);
			h += '<div class="ep' + (w.status === 1 ? ' watched' : '') + (Item.area === 'episodes' && e === Item.ei ? ' focus' : '') + '">' +
				(multi ? '<span class="n">' + num + '</span>' : '') + esc(label) + '<span class="d">' + right + '</span></div>';
		}
		$('episodes').innerHTML = h;
	},

	current: function () { return Item.seasons[Item.si].eps[Item.ei]; },

	TABS: 6, tabOff: 0,
	tabs: function () {
		var out = [];
		if (Item.trailerB64()) out.push({ trailer: true });
		for (var i = 0; i < Item.seasons.length; i++) out.push({ season: i });
		return out;
	},
	// the tab under focus: the trailer, or the selected season
	tabIndex: function () {
		var withTrailer = Item.trailerB64() ? 1 : 0;
		return Item.onTrailer && withTrailer ? 0 : withTrailer + Item.si;
	},
	moveTab: function (d) {
		var tabs = Item.tabs(), i = Item.tabIndex() + d;
		if (i < 0 || i >= tabs.length) return;
		if (tabs[i].trailer) { Item.onTrailer = true; return; }
		Item.onTrailer = false;
		if (tabs[i].season !== Item.si) { Item.si = tabs[i].season; Item.ei = 0; Item.top = 0; }
	},

	// A plain movie (one video, no seasons) gets "continue" / "from start" rows instead of a list.
	single: function () { return Item.seasons.length === 1 && !Item.seasons[0].number && Item.seasons[0].eps.length === 1; },
	actions: function () {
		var ep = Item.seasons[0].eps[0];
		var w = ep.watching || { status: ep.watched, time: 0 };
		var out = (w.status === 0 && w.time > 0)
			? [{ label: 'Продолжить с ' + fmtTime(w.time), fromStart: false }, { label: 'Начать сначала', fromStart: true }]
			: [{ label: 'Смотреть', fromStart: true }];
		if (Item.trailerB64()) out.push({ label: 'Трейлер', trailer: true });
		return out;
	},

	// The trailer is an HLS master on the same CDN as the films.
	trailerB64: function () {
		var t = Item.data && Item.data.trailer, u = t && t.url;
		return u && u.indexOf('/s/') > 0 ? u.split('/s/')[1].split('/')[0] : null;
	},

	playTrailer: function () {
		var b = Item.trailerB64();
		if (!b) { UI.toast('У этого тайтла нет трейлера'); return; }
		Player.play({ hls: b, mp4: null, trailer: true, title: shortTitle(Item.data.title) + '  ·  трейлер', start: 0,
			id: Item.data.id, video: 0, season: null, duration: 0, audios: [], subs: [], w: 0, h: 0 });
	},

	pickFile: function (ep) {
		var files = ep.files || [];
		for (var q = Item.quality; q < QUALITIES.length; q++)
			for (var i = 0; i < files.length; i++)
				if (files[i].quality === QUALITIES[q] && files[i].url && files[i].url.http) return files[i];
		for (var j = 0; j < files.length; j++) if (files[j].url && files[j].url.http && (files[j].w || 0) <= 1920) return files[j];
		return null;
	},

	play: function (fromStart) {
		var ep = Item.current();
		if (CLOUD && !ep.files) {
			UI.loading(true);
			Net.get('/media?id=' + Item.data.id + '&mid=' + ep.id + '&srv=' + (Home.server || 0), function (m) {
				UI.loading(false);
				ep.files = m.files; ep.audios = m.audios; ep.subtitles = m.subtitles;
				Item.play(fromStart);
			}, function (msg) {
				// switching episodes from the player: don't strand it on a black screen
				if (document.body.className === 'playing') { Player.active = true; Player.stop(); }
				Net.fail(msg);
			});
			return;
		}
		var f = Item.pickFile(ep);
		if (!f) { UI.toast('Нет подходящего файла'); return; }
		var w = ep.watching || {};
		var start = (!fromStart && w.status === 0 && w.time > 0) ? w.time : 0;
		var s = Item.seasons[Item.si];
		var title = shortTitle(Item.data.title) + (s.number ? '  ·  S' + s.number + 'E' + ep.number : (s.eps.length > 1 ? '  ·  часть ' + ep.number : ''));
		var audios = (ep.audios || []).slice(0).sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
		var hls = f.url.hls && f.url.hls.indexOf('/s/') > 0 ? f.url.hls.split('/s/')[1].split('/')[0] : null;
		Player.play({
			mp4: f.url.http, hls: hls, title: title + '  ·  ' + f.quality, start: start,
			id: Item.data.id, video: ep.number, season: s.number || null,
			duration: ep.duration || 0, audios: audios, subs: ep.subtitles || [], w: f.w || 0, h: f.h || 0
		});
	},

	// The episode before (d = -1) or after (d = 1) the current one, across seasons.
	hasNeighbour: function (d) {
		if (!Item.data || Item.single()) return null;
		var si = Item.si, ei = Item.ei + d;
		while (si >= 0 && si < Item.seasons.length) {
			var n = Item.seasons[si].eps.length;
			if (ei >= 0 && ei < n) return { si: si, ei: ei };
			si += d;
			if (si < 0 || si >= Item.seasons.length) break;
			ei = d > 0 ? 0 : Item.seasons[si].eps.length - 1;
		}
		return null;
	},

	// Play the neighbouring episode; false when there's none.
	step: function (d) {
		var to = Item.hasNeighbour(d);
		if (!to) return false;
		Item.si = to.si; Item.ei = to.ei;
		Item.scroll();
		var ep = Item.current();
		if (d > 0 && ep.watching && ep.watching.status === 1) ep.watching = { status: -1, time: 0 }; // rewatch from the start
		Item.play();
		return true;
	},

	// Called by the player when an episode finishes.
	// Keep the page's progress in step with the player, so coming back needs no reload.
	markLocal: function (season, video, time, dur) {
		for (var s = 0; s < Item.seasons.length; s++) {
			if ((Item.seasons[s].number || null) !== (season || null)) continue;
			var eps = Item.seasons[s].eps;
			for (var e = 0; e < eps.length; e++) if (eps[e].number === video)
				eps[e].watching = (dur && time >= dur - 60) ? { status: 1, time: 0 } : { status: 0, time: Math.floor(time) };
		}
	},

	// Back from the player: the page is still here, just redraw it.
	back: function (id) {
		if (!Item.data || Item.data.id !== id) { Item.open(id, true); return; }
		UI.screen('item');
		App.handler = Item;
		Item.act = 0;
		Item.render();
	},

	// Red key: put the title into the "Посмотреть" bookmark folder, or take it out.
	toWatch: null,      // {id, title} of that folder
	inToWatch: null,    // is the open title in it (null until known)

	toWatchFolder: function (done) {
		if (Item.toWatch) return done(Item.toWatch);
		Net.api('bookmarks', function (r) {
			var f = r.items || [];
			for (var i = 0; i < f.length; i++) if (String(f[i].title).toLowerCase() === 'посмотреть') { Item.toWatch = f[i]; return done(f[i]); }
			Net.api('bookmarks/create?_post=1&title=' + encodeURIComponent('Посмотреть'), function (c) {
				Item.toWatch = c.folder || (c.items && c.items[0]) || null;
				if (Item.toWatch) done(Item.toWatch); else UI.toast('Не удалось создать папку «Посмотреть»');
			});
		});
	},

	checkToWatch: function (id) {
		Item.inToWatch = null;
		Item.toWatchFolder(function (folder) {
			Net.api('bookmarks/get-item-folders?item=' + id, function (r) {
				if (!Item.data || Item.data.id !== id) return;
				var fs = r.folders || [];
				Item.inToWatch = false;
				for (var i = 0; i < fs.length; i++) if (fs[i].id === folder.id) Item.inToWatch = true;
				Item.renderHints();
			}, function () {});
		});
	},

	toggleToWatch: function () {
		var id = Item.data.id, adding = !Item.inToWatch;
		Item.toWatchFolder(function (folder) {
			Net.api('bookmarks/' + (adding ? 'add' : 'remove-item') + '?_post=1&item=' + id + '&folder=' + folder.id, function () {
				Item.inToWatch = adding;
				Item.renderHints();
				UI.toast(adding ? 'Добавлено в «Посмотреть»' : 'Убрано из «Посмотреть»');
				for (var k in Home.cache) if (SECTIONS[parseInt(k, 10)] && SECTIONS[parseInt(k, 10)].bookmarks) delete Home.cache[k];
			});
		});
	},

	renderHints: function () {
		$('itemHints').innerHTML =
			'<span class="k red"></span> ' + (Item.inToWatch ? 'убрать из «Посмотреть»' : 'в «Посмотреть»') +
			'&nbsp;&nbsp;&nbsp;<span class="k green"></span> качество: ' + QUALITIES[Item.quality] +
			'&nbsp;&nbsp;&nbsp;<span class="k yellow"></span> просмотрено' +
			(Item.trailerB64() ? '&nbsp;&nbsp;&nbsp;<span class="k blue"></span> трейлер' : '') +
			'&nbsp;&nbsp;&nbsp;TOOLS — размер экрана';
	},

	toggleWatched: function () {
		var ep = Item.current(), s = Item.seasons[Item.si];
		var q = 'watching/toggle?id=' + Item.data.id + '&video=' + ep.number + (s.number ? '&season=' + s.number : '');
		Net.api(q, function () {
			var st = ep.watching ? ep.watching.status : ep.watched;
			ep.watching = { status: st === 1 ? -1 : 1, time: 0 };
			Shelf.staleContinue();
			Item.render();
		});
	},

	key: function (k) {
		var eps = Item.seasons[Item.si].eps;
		if (k === K.RETURN) { Home.open(); return; }
		// colour keys in remote order: red "Посмотреть", green quality, yellow watched, blue trailer
		if (k === K.RED) { Item.toggleToWatch(); return; }
		if (k === K.GREEN) { Item.quality = (Item.quality + 1) % QUALITIES.length; Item.renderHints(); return; }
		if (k === K.YELLOW) { Item.toggleWatched(); return; }
		if (k === K.BLUE) { Item.playTrailer(); return; }
		if (Item.area === 'seasons') {
			if (Item.onTrailer && (k === K.ENTER || k === K.PLAY)) { Item.playTrailer(); return; }
			if (k === K.LEFT) Item.moveTab(-1);
			else if (k === K.RIGHT) Item.moveTab(1);
			else if (k === K.DOWN || k === K.ENTER) { Item.onTrailer = false; Item.area = 'episodes'; }
			Item.render();
			return;
		}
		if (Item.single()) {
			var acts = Item.actions();
			if (k === K.UP && Item.act > 0) Item.act--;
			else if (k === K.DOWN && Item.act < acts.length - 1) Item.act++;
			else if (k === K.ENTER || k === K.PLAY) { if (acts[Item.act].trailer) Item.playTrailer(); else Item.play(acts[Item.act].fromStart); return; }
			Item.render();
			return;
		}
		if (k === K.UP) {
			if (Item.ei > 0) Item.ei--;
			else if (Item.seasons.length > 1 || (Item.seasons[0].number && Item.trailerB64())) Item.area = 'seasons';
		}
		else if (k === K.DOWN && Item.ei < eps.length - 1) Item.ei++;
		else if (k === K.CH_DOWN) Item.ei = Math.min(eps.length - 1, Item.ei + Item.VISIBLE);
		else if (k === K.CH_UP) Item.ei = Math.max(0, Item.ei - Item.VISIBLE);
		else if (k === K.ENTER || k === K.PLAY) { Item.play(); return; }
		Item.scroll();
		Item.render();
	}
};

/* ---------- player (Samsung INFOLINK-PLAYER plugin, HTML5 fallback) ---------- */

var Player = {
	plugin: null, html5: null, v: null,
	time: 0, duration: 0, paused: false, active: false,
	seekTarget: null, seekTimer: null, osdTimer: null, saveTimer: null, lastSaved: 0,
	menu: false, track: 0, menuIdx: 0, retries: 0,
	sub: -1, subPref: null, cues: [], cueText: '', stamp: 0, subTimer: null,
	nextAt: null, nextOff: false,

	init: function () {
		var p = $('pluginPlayer');
		if (p && typeof p.Play !== 'undefined') {
			Player.plugin = p;
			p.OnCurrentPlayTime = 'Player.onTime';
			p.OnStreamInfoReady = 'Player.onInfo';
			p.OnRenderingComplete = 'Player.onEnd';
			p.OnConnectionFailed = 'Player.onError';
			p.OnNetworkDisconnected = 'Player.onError';
			p.OnRenderError = 'Player.onError';
			p.OnStreamNotFound = 'Player.onError';
			p.OnBufferingStart = 'Player.onBufStart';
			p.OnBufferingComplete = 'Player.onBufEnd';
		} else {
			// Desktop testing only.
			var vid = document.createElement('video');
			vid.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;background:#000;display:none;object-fit:contain';
			document.body.insertBefore(vid, document.body.firstChild);
			vid.ontimeupdate = function () { Player.onTime(vid.currentTime * 1000); };
			vid.onloadedmetadata = function () { Player.duration = vid.duration; };
			vid.onended = function () { Player.onEnd(); };
			vid.onerror = function () { Player.onError(); };
			Player.html5 = vid;
		}
	},

	play: function (v) {
		Player.v = v;
		Player.gotTime = false;
		Player.time = v.start || 0; Player.duration = v.duration || 0;
		Player.paused = false; Player.active = true; Player.seekTarget = null;
		Player.menu = false; Player.track = 0; Player.retries = 0; $('audioMenu').style.display = 'none';
		Player.nextAt = null; Player.nextOff = false; $('nextUp').style.display = 'none';
		Player.renderHints();
		// keep the subtitle language chosen for the previous episode
		var pref = -1;
		for (var si = 0; Player.subPref && si < v.subs.length; si++) if (v.subs[si].lang === Player.subPref && !v.subs[si].forced) { pref = si; break; }
		var keepPref = Player.subPref;
		Player.setSub(pref);
		if (pref < 0) Player.subPref = keepPref;
		clearInterval(Player.subTimer);
		Player.subTimer = setInterval(Player.tick, 250);
		Player.lastSaved = Player.time;
		document.body.className = 'playing';
		App.handler = Player;
		$('osdTitle').innerHTML = esc(v.title);
		Player.showOsd();
		Player.bufferingUi(true);
		if (pluginAPI) pluginAPI.setOffScreenSaver();
		Player.open(v.start || 0);
		clearInterval(Player.saveTimer);
		Player.saveTimer = setInterval(function () { Player.save(); }, 30000);
	},

	// HLS through the proxy: the CDN serves any segment instantly, while seeking
	// deep into a multi-GB mp4 makes it stall for a minute.
	url: function () {
		var v = Player.v;
		if (v.trailer) return PROXY + '/hls/' + v.hls + '/1/index.m3u8' + (Player.plugin ? '|COMPONENT=HLS' : '');
		if (Player.plugin && v.hls) {
			var a = v.audios[Player.track];
			return PROXY + '/hls/' + v.hls + '/' + (a && a.index ? a.index : 1) + '/index.m3u8|COMPONENT=HLS';
		}
		return v.mp4;
	},

	// Letterbox/pillarbox instead of stretching to 16:9.
	fit: function () {
		var v = Player.v, W = 960, H = 540;
		if (!Player.plugin || !v.w || !v.h) { if (Player.plugin) Player.plugin.SetDisplayArea(0, 0, W, H); return; }
		var k = Math.min(W / v.w, H / v.h);
		var w = Math.round(v.w * k), h = Math.round(v.h * k);
		Player.plugin.SetDisplayArea(Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
	},

	open: function (at) {
		Player.bufferingUi(true);
		Player.time = at;
		if (Player.plugin) {
			Player.fit();
			var u = Player.url();
			if (at > 5) Player.plugin.ResumePlay(u, Math.floor(at));
			else Player.plugin.Play(u);
		} else {
			var h = Player.html5;
			h.style.display = 'block';
			h.src = Player.url();
			h.onloadeddata = function () { if (at > 5) h.currentTime = at; Player.bufferingUi(false); h.onloadeddata = null; };
			h.play();
		}
	},

	// Restart the stream at the current position (audio switch, dropped connection).
	reopen: function () {
		var at = Player.time;
		if (Player.plugin) Player.plugin.Stop();
		Player.paused = false;
		Player.open(at);
	},

	// Previous / next episode from the player: save this one, start the other.
	switchEp: function (d) {
		var to = Item.hasNeighbour(d);
		if (!to) { UI.toastPlayer(d > 0 ? 'Это последняя серия' : 'Это первая серия'); return; }
		Player.save();
		Player.active = false;
		clearInterval(Player.saveTimer);
		clearTimeout(Player.seekTimer); Player.seekTarget = null;
		if (Player.plugin) Player.plugin.Stop(); else Player.html5.pause();
		$('nextUp').style.display = 'none';
		var s = Item.seasons[to.si], ep = s.eps[to.ei];
		UI.toastPlayer((s.number ? 'S' + s.number + 'E' : 'Часть ') + ep.number + (ep.title ? ' · ' + ep.title : ''));
		Item.step(d);
	},

	stop: function () {
		if (!Player.active) return;
		Player.save();
		Player.active = false;
		clearInterval(Player.saveTimer);
		clearInterval(Player.subTimer);
		Player.showCue('');
		clearTimeout(Player.seekTimer);
		if (Player.plugin) Player.plugin.Stop();
		else { Player.html5.pause(); Player.html5.removeAttribute('src'); Player.html5.style.display = 'none'; }
		if (pluginAPI) pluginAPI.setOnScreenSaver();
		Shelf.staleContinue();
		document.body.className = '';
		Player.hideOsd();
		Player.bufferingUi(false);
		Item.back(Player.v.id);
	},

	save: function () {
		var v = Player.v;
		if (v && !v.trailer && Player.time >= 5) Item.markLocal(v.season, v.video, Player.time, Player.duration);
		if (!v || v.trailer || Player.time < 5 || Math.abs(Player.time - Player.lastSaved) < 3) return;
		Player.lastSaved = Player.time;
		Net.api('watching/marktime?id=' + v.id + '&video=' + v.video + (v.season ? '&season=' + v.season : '') + '&time=' + Math.floor(Player.time), function () {}, function () {});
	},

	onTime: function (ms) {
		Player.time = ms / 1000;
		Player.stamp = +new Date();
		if (Player.time > 30) Player.retries = 0;
		Player.nextUp();
		if (Player.plugin && !Player.duration) {
			var d = Player.plugin.GetDuration();
			if (d > 0) Player.duration = d / 1000;
		}
		Player.bufferingUi(false);
		if ($('osd').style.display === 'block') Player.renderOsd();
	},
	// Last 30 seconds of an episode: "Следующая серия через 10", OK = now, Return = stay.
	nextUp: function () {
		var v = Player.v, d = Player.duration;
		if (v.trailer || Player.nextOff || !d || Player.time < d - 30 || !Item.hasNeighbour(1)) return;
		if (Player.nextAt === null) Player.nextAt = Player.time + 10;
		var left = Math.ceil(Player.nextAt - Player.time);
		if (left <= 0) { Player.switchEp(1); return; }
		var el = $('nextUp');
		el.innerHTML = 'Следующая серия через ' + left + ' &nbsp;·&nbsp; OK — сейчас &nbsp;·&nbsp; RETURN — остаться';
		el.style.display = 'block';
	},

	onInfo: function () {
		Player.fit();
		if (Player.plugin) { var d = Player.plugin.GetDuration(); if (d > 0) Player.duration = d / 1000; }
	},
	onBufStart: function () { Player.bufferingUi(true); },
	onBufEnd: function () { Player.bufferingUi(false); },
	onEnd: function () {
		if (!Player.active) return;
		if (Player.v.trailer) { Player.stop(); return; }
		if (Player.duration && Player.time < Player.duration - 90) {
			Screen.log('player_early_end at=' + Math.floor(Player.time));
			return Player.recover();
		}
		Player.time = Player.duration;
		Player.save();
		Player.active = false;
		clearInterval(Player.saveTimer);
		if (Player.plugin) Player.plugin.Stop();
		if (!Item.step(1)) { Player.active = true; Player.stop(); }
	},
	onError: function () {
		Screen.log('player_error at=' + Math.floor(Player.time));
		Player.recover();
	},

	recover: function () {
		if (!Player.active) return;
		Player.save();
		if (Player.retries < 3) {
			Player.retries++;
			UI.toastPlayer('Связь прервалась, переподключаюсь…');
			setTimeout(function () { if (Player.active) Player.reopen(); }, 1500);
			return;
		}
		UI.toast('Не удалось воспроизвести видео. Попробуй другое качество (зелёная кнопка).');
		Player.stop();
	},

	bufferingUi: function (on) {
		if (Player.buffering === on) return;
		Player.buffering = on;
		$('buffering').style.display = on ? 'block' : 'none';
	},

	showOsd: function () {
		if ($('osd').style.display !== 'block') {
			$('osd').style.display = 'block';
			$('subs').style.bottom = '160px';
			Player.renderHints();
		}
		Player.renderOsd();
		clearTimeout(Player.osdTimer);
		Player.osdTimer = setTimeout(function () { if (!Player.paused && Player.seekTarget === null) Player.hideOsd(); }, 4000);
	},

	// Subtitles sit at the bottom and move up only while the control bar covers them.
	hideOsd: function () {
		$('osd').style.display = 'none';
		$('subs').style.bottom = '28px';
	},

	renderOsd: function () {
		var d = Player.duration || 1;
		$('osdProgress').style.width = Math.min(100, Player.time / d * 100) + '%';
		var seek = $('osdSeek');
		if (Player.seekTarget !== null) {
			seek.style.display = 'block';
			seek.style.left = Math.min(100, Player.seekTarget / d * 100) + '%';
			$('osdTime').innerHTML = '→ ' + fmtTime(Player.seekTarget) + ' / ' + fmtTime(Player.duration);
		} else {
			seek.style.display = 'none';
			$('osdTime').innerHTML = fmtTime(Player.time) + ' / ' + fmtTime(Player.duration);
		}
		$('osdState').innerHTML = Player.paused ? 'ПАУЗА' : '';
	},

	// The hint line only changes per video, not per tick.
	renderHints: function () {
		var n = Player.trackCount(), eps = !Player.v.trailer && Item.hasNeighbour(1) !== null;
		$('osdHints').innerHTML = 'OK — пауза &nbsp;·&nbsp; ◀ ▶ — 10 сек &nbsp;·&nbsp; ◀◀ ▶▶ — 1 мин &nbsp;·&nbsp; CH — 5 мин' +
			(n > 1 ? ' &nbsp;·&nbsp; ▲ — озвучка' : '') + (Player.v.subs.length ? ' &nbsp;·&nbsp; ▼ — субтитры' : '') +
			(eps ? ' &nbsp;·&nbsp; <span class="k red"></span><span class="k green"></span> — серии' : '') + ' &nbsp;·&nbsp; RETURN — выход';
	},

	trackCount: function () {
		var v = Player.v;
		if (!v || !v.audios) return 0;
		return (!Player.plugin || v.hls) ? v.audios.length : 0;
	},

	trackLabel: function (i) {
		var a = Player.v.audios && Player.v.audios[i];
		if (!a) return 'Дорожка ' + (i + 1);
		var parts = [];
		if (a.type && a.type.title) parts.push(a.type.title);
		if (a.author && a.author.title) parts.push(a.author.title);
		if (a.lang) parts.push(a.lang.toUpperCase());
		if (a.codec) parts.push(a.codec.toUpperCase());
		return parts.join(' · ') || ('Дорожка ' + (i + 1));
	},

	subLabel: function (i) {
		var list = Player.v.subs, sub = list[i], same = 0, n = 0;
		for (var j = 0; j < list.length; j++) if (list[j].lang === sub.lang) { same++; if (j <= i) n = same; }
		return (sub.lang ? sub.lang.toUpperCase() : 'Субтитры') + (same > 1 ? ' ' + n : '') + (sub.forced ? ' (только надписи)' : '');
	},

	// Menu entries for the open menu: audio tracks, or "off" + subtitle files.
	menuEntries: function () {
		var out = [], i;
		if (Player.menu === 'audio') for (i = 0; i < Player.trackCount(); i++) out.push({ label: Player.trackLabel(i), on: i === Player.track });
		else {
			out.push({ label: 'Выключены', on: Player.sub < 0 });
			for (i = 0; i < Player.v.subs.length; i++) out.push({ label: Player.subLabel(i), on: i === Player.sub });
		}
		return out;
	},

	openMenu: function (kind) {
		if (kind === 'audio' && Player.trackCount() < 2) { UI.toastPlayer('В этом файле одна озвучка'); return; }
		if (kind === 'subs' && !Player.v.subs.length) { UI.toastPlayer('Субтитров нет'); return; }
		Player.menu = kind;
		Player.menuIdx = kind === 'audio' ? Player.track : Player.sub + 1;
		Player.renderMenu();
	},

	renderMenu: function () {
		var e = Player.menuEntries(), n = e.length;
		var h = '<div class="am-title">' + (Player.menu === 'audio' ? 'Озвучка' : 'Субтитры') + '</div>';
		var first = Math.max(0, Math.min(Player.menuIdx - 4, n - 8));
		for (var i = first; i < n && i < first + 8; i++)
			h += '<div class="am-item' + (i === Player.menuIdx ? ' focus' : '') + '">' + (e[i].on ? '● ' : '') + esc(e[i].label) + '</div>';
		$('audioMenu').innerHTML = h;
		$('audioMenu').style.display = 'block';
	},

	menuKey: function (k) {
		var n = Player.menuEntries().length;
		if (k === K.UP && Player.menuIdx > 0) Player.menuIdx--;
		else if (k === K.DOWN && Player.menuIdx < n - 1) Player.menuIdx++;
		else if (k === K.ENTER) {
			var kind = Player.menu, pick = Player.menuIdx;
			Player.closeMenu();
			if (kind === 'audio' && pick !== Player.track) { Player.track = pick; Player.reopen(); }
			if (kind === 'subs') Player.setSub(pick - 1);
			return;
		}
		else if (k === K.RETURN) { Player.closeMenu(); return; }
		Player.renderMenu();
	},

	closeMenu: function () { Player.menu = false; $('audioMenu').style.display = 'none'; },

	/* subtitles: .srt parsed by the proxy, drawn over the video by a 250 ms ticker */

	setSub: function (i) {
		Player.sub = i; Player.cues = []; Player.cueIdx = 0; Player.showCue('');
		Player.subPref = i >= 0 ? Player.v.subs[i].lang : null;
		if (i < 0) return;
		var u = Player.v.subs[i].url || '';
		var b = u.indexOf('/s/') > 0 ? u.split('/s/')[1].split('/')[0] : null;
		if (!b) return;
		Net.get('/srt/' + b + '/subs.json', function (cues) { if (Player.sub === i) Player.cues = cues; },
			function () { UI.toastPlayer('Не удалось загрузить субтитры'); });
	},

	now: function () {
		var t = Player.time;
		if (!Player.paused && Player.stamp) t += Math.min(2, (+new Date() - Player.stamp) / 1000);
		return t;
	},

	tick: function () {
		var c = Player.cues;
		if (!Player.active || Player.sub < 0 || !c.length) return;
		var t = Player.now() + (Player.v.subs[Player.sub].shift || 0);
		var lo = 0, hi = c.length - 1, found = -1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (c[mid][0] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
		}
		Player.showCue(found >= 0 && t <= c[found][1] ? c[found][2] : '');
	},

	showCue: function (text) {
		if (text === Player.cueText) return;
		Player.cueText = text;
		var el = $('subs');
		el.innerHTML = esc(text).replace(/\n/g, '<br />');
		el.style.display = text ? 'block' : 'none';
	},

	togglePause: function () {
		if (Player.paused) { if (Player.plugin) Player.plugin.Resume(); else Player.html5.play(); }
		else { if (Player.plugin) Player.plugin.Pause(); else Player.html5.pause(); }
		Player.paused = !Player.paused;
		Player.showOsd();
	},

	// Seek presses accumulate, then one jump happens after a short pause.
	seek: function (delta) {
		var base = Player.seekTarget !== null ? Player.seekTarget : Player.time;
		var max = Player.duration ? Player.duration - 5 : base + delta;
		Player.seekTarget = Math.max(0, Math.min(max, base + delta));
		Player.showOsd();
		clearTimeout(Player.seekTimer);
		Player.seekTimer = setTimeout(Player.applySeek, 900);
	},
	applySeek: function () {
		if (Player.seekTarget === null) return;
		var diff = Math.round(Player.seekTarget - Player.time);
		Player.seekTarget = null;
		if (Player.plugin) {
			if (diff > 0) Player.plugin.JumpForward(diff);
			else if (diff < 0) Player.plugin.JumpBackward(-diff);
		} else Player.html5.currentTime = Math.max(0, Player.html5.currentTime + diff);
		Player.time += diff;
		Player.stamp = +new Date();
		Player.bufferingUi(diff !== 0);
		Player.showOsd();
	},

	key: function (k) {
		if (Player.menu) { Player.menuKey(k); return; }
		if ($('nextUp').style.display === 'block') {
			if (k === K.ENTER) { Player.switchEp(1); return; }
			if (k === K.RETURN) { Player.nextOff = true; $('nextUp').style.display = 'none'; return; }
		}
		if (k === K.RED) { Player.switchEp(-1); return; }
		if (k === K.GREEN) { Player.switchEp(1); return; }
		if (k === K.FF) { Player.seek(60); return; }
		if (k === K.RW) { Player.seek(-60); return; }
		if (k === K.RETURN || k === K.STOP) Player.stop();
		else if (k === K.UP || k === K.YELLOW) Player.openMenu('audio');
		else if (k === K.DOWN || k === K.BLUE) Player.openMenu('subs');
		else if (k === K.ENTER || k === K.PLAY || k === K.PAUSE) {
			if (Player.seekTarget !== null) { clearTimeout(Player.seekTimer); Player.applySeek(); }
			else if (k === K.ENTER && $('osd').style.display !== 'block' && !Player.paused) Player.showOsd();
			else if (k === K.PLAY && !Player.paused) Player.showOsd();
			else Player.togglePause();
		}
		else if (k === K.RIGHT) Player.seek(10);
		else if (k === K.LEFT) Player.seek(-10);
		else if (k === K.CH_UP) Player.seek(300);
		else if (k === K.CH_DOWN) Player.seek(-300);
		else Player.showOsd();
	}
};

/* ---------- app ---------- */

// Screen markup lives here, not in index.html, so a remote update can change it too.
var MARKUP = [
	'<div id="app">',
	'	<div id="auth" class="screen">',
	'		<div class="logo">KinoPub</div>',
	'		<div class="auth-text">Открой на телефоне или компьютере</div>',
	'		<div class="auth-url" id="authUrl">kino.watch/device</div>',
	'		<div class="auth-text">и введи код</div>',
	'		<div class="auth-code" id="authCode">…</div>',
	'		<div class="auth-hint" id="authHint"></div>',
	'	</div>',
	'',
	'	<div id="home" class="screen">',
	'		<div id="menu"></div>',
	'		<div id="content">',
	'			<div id="sectionTitle"></div>',
	'			<div id="searchBox">',
	'				<div id="searchQuery"></div>',
	'				<div id="keyboard"></div>',
	'			</div>',
	'			<div id="grid"></div>',
	'			<div id="gridEmpty"></div>',
	'		</div>',
	'	</div>',
	'',
	'	<div id="item" class="screen">',
	'		<img id="itemPoster" src="" alt="" />',
	'		<div id="itemInfo">',
	'			<div id="itemTitle"></div>',
	'			<div id="itemMeta"></div>',
	'			<div id="itemPlot"></div>',
	'			<div id="seasons"></div>',
	'			<div id="episodes"></div>',
	'		</div>',
	'		<div id="itemHints"></div>',
	'	</div>',
	'',
	'	<div id="loading">Загрузка…</div>',
	'	<div id="toast"></div>',
	'</div>',
	'',
	'<div id="osd">',
	'	<div id="osdTitle"></div>',
	'	<div id="osdBar"><div id="osdProgress"></div><div id="osdSeek"></div></div>',
	'	<div id="osdTime"></div>',
	'	<div id="osdState"></div>',
	'	<div id="osdHints"></div>',
	'</div>',
	'<div id="subs"></div>',
	'<div id="audioMenu"></div>',
	'<div id="playerToast"></div>',
	'<div id="nextUp"></div>',
	'<div id="buffering">Буферизация…</div>',
	'<div id="zoomInfo"></div>'
].join('\n');


var App = {
	handler: null,

	init: function () {
		if (!$('app')) $('root').innerHTML = MARKUP;
		Store.init();
		Screen.init();
		Player.init();
		if (widgetAPI) widgetAPI.sendReadyEvent();
		$('anchor').focus();
		if (!tvKey) document.onkeydown = function (e) {
			e = e || window.event;
			if ((e.target || e.srcElement) !== $('anchor')) App.onKey(e); // anchor already handled it
		};
		if (CLOUD) {
			if (Store.get('token')) Home.open(); else App.showAuth();
			return;
		}
		Net.get('/auth/status', function (r) {
			if (r.authorized) Home.open(); else App.showAuth();
		}, function () {
			UI.screen('auth');
			$('authCode').innerHTML = '—';
			$('authHint').innerHTML = 'Домашний сервер ' + PROXY.replace(/^https?:\/\//, '').replace(/\/kp$/, '') + ' недоступен. Нажми OK, чтобы повторить.';
			App.handler = { key: function (k) { if (k === K.ENTER) App.init(); } };
		});
	},

	showAuth: function () {
		if (App.handler !== Auth) Auth.start();
	},

	onKey: function (e) {
		var k = e.keyCode;
		if (k === K.RETURN && widgetAPI) widgetAPI.blockNavigation(e);
		if (k === K.EXIT) {
			if (Player.active) { Player.save(); if (Player.plugin) Player.plugin.Stop(); }
			return; // let the TV close the app
		}
		if (!tvKey && k === 8 && e.preventDefault) e.preventDefault();
		if (k === K.TOOLS && !Player.active) { Screen.cycle(); return; }
		if (App.handler && App.handler.key) App.handler.key(k);
	}
};

window.onerror = function (msg, url, line) {
	Screen.log('js_error ' + msg + ' @' + String(url).split('/').pop() + ':' + line);
};

// Called by the app manager when the widget is shown: let the TV handle volume.
window.onShow = function () {
	if (pluginAPI && tvKey) {
		pluginAPI.unregistKey(tvKey.KEY_VOL_UP);
		pluginAPI.unregistKey(tvKey.KEY_VOL_DOWN);
		pluginAPI.unregistKey(tvKey.KEY_MUTE);
		var nnavi = $('pluginObjectNNavi');
		if (nnavi && nnavi.SetBannerState) nnavi.SetBannerState(1);
	}
};

window.onunload = function () {
	if (Player.active) { Player.save(); if (Player.plugin) Player.plugin.Stop(); }
};
