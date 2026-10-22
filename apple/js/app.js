/* KP Apple: a design study of the Kinopub app in the style of Apple's TV app.
   Static demo data (js/data.js), no login, no playback. ES5 for the 2013 TV. */

var widgetAPI = (typeof Common !== 'undefined') ? new Common.API.Widget() : null;
var tvKey = (typeof Common !== 'undefined') ? new Common.API.TVKeyValue() : null;
var K = tvKey ? {
	LEFT: tvKey.KEY_LEFT, RIGHT: tvKey.KEY_RIGHT, UP: tvKey.KEY_UP, DOWN: tvKey.KEY_DOWN,
	ENTER: tvKey.KEY_ENTER, RETURN: tvKey.KEY_RETURN, PLAY: tvKey.KEY_PLAY
} : { LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40, ENTER: 13, RETURN: 8, PLAY: 80 };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function item(id) { return DATA.items[String(id)]; }
function setClass(el, cls, on) {
	if (typeof el === 'string') el = $(el);
	if (!el) return;
	var has = (' ' + el.className + ' ').indexOf(' ' + cls + ' ') >= 0;
	if (on && !has) el.className += ' ' + cls;
	else if (!on && has) el.className = (' ' + el.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
}
function move(el, x, y) { el.style.webkitTransform = 'translate(' + x + 'px,' + y + 'px)'; }
function duration(it) {
	if (it.eps) return it.eps.seasons + (it.eps.seasons === 1 ? ' сезон' : it.eps.seasons < 5 ? ' сезона' : ' сезонов');
	var m = Math.round((it.dur || 0) / 60);
	return m ? (m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин') : '';
}
function metaLine(it) {
	var parts = [];
	if (it.year) parts.push(it.year);
	if (it.genres && it.genres.length) parts.push(it.genres.join(', '));
	var d = duration(it); if (d) parts.push(d);
	return '<b>HD</b><b>16+</b>' + esc(parts.join(' · '));
}
function toast(msg) {
	var t = $('toast'); t.innerHTML = esc(msg); t.style.display = 'block';
	clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.style.display = 'none'; }, 2200);
}

/* card geometry: tvOS grids are 260 pt (6 columns) and 410 pt (4 columns) wide with 40 pt gaps */
var CARD = { poster: { w: 130, gap: 20 }, wide: { w: 200, gap: 20 } };
var VIEW = 880; // 960 minus the 40 px safe area on both sides

/* ---------- home ---------- */

var Home = {
	zone: 'hero', tab: 0, btn: 0, hero: 0, rows: [], r: 0, bgFront: 0,
	TABS: ['Смотреть', 'Фильмы', 'Сериалы', 'Поиск'],

	build: function () {
		var h = '<div class="hero" id="hero"><div class="hero-info">' +
			'<div class="eyebrow" id="heroEyebrow"></div><div class="big-title" id="heroTitle"></div>' +
			'<div class="meta" id="heroMeta"></div><div class="plot" id="heroPlot"></div>' +
			'<div class="buttons"><span class="btn primary" id="hb0">&#9654;&nbsp; Смотреть</span><span class="btn" id="hb1">Подробнее</span></div>' +
			'</div><div class="dots" id="dots"></div></div>';
		for (var r = 0; r < DATA.rows.length; r++) {
			var row = DATA.rows[r], kind = row.kind, c = CARD[kind];
			Home.rows.push({ idx: 0, off: 0, kind: kind, ids: row.ids });
			h += '<div class="shelf ' + kind + '" id="shelf' + r + '"><h2>' + esc(row.title) + '</h2><div class="row" id="row' + r + '">';
			for (var i = 0; i < row.ids.length; i++) {
				var it = item(row.ids[i]);
				h += '<div class="card ' + kind + '" id="c' + r + '_' + i + '" style="left:' + (i * (c.w + c.gap)) + 'px">' +
					'<div class="art"><img src="' + (kind === 'wide' ? it.w : it.p) + '" />' +
					(r === 0 && it.progress ? '<div class="bar"><i style="width:' + Math.round(it.progress * 100) + '%"></i></div>' : '') +
					'<div class="shine"></div></div><div class="cap">' + esc(it.title) + '</div></div>';
			}
			h += '</div></div>';
		}
		$('column').innerHTML = h;
		var t = '<span class="tabbar">';
		for (var j = 0; j < Home.TABS.length; j++) t += '<span class="tab' + (j === 0 ? ' sel' : '') + '" id="tab' + j + '">' + Home.TABS[j] + '</span>';
		$('tabs').innerHTML = t + '</span>';
		Home.showHero(0);
		Home.focus();
	},

	// The hero crossfades between two image layers.
	showHero: function (n) {
		Home.hero = (n + DATA.hero.length) % DATA.hero.length;
		var it = item(DATA.hero[Home.hero]);
		var back = $('bg' + (1 - Home.bgFront)), front = $('bg' + Home.bgFront);
		back.src = it.bg;
		setClass(back, 'on', true); setClass(front, 'on', false);
		Home.bgFront = 1 - Home.bgFront;
		$('heroEyebrow').innerHTML = it.eps ? 'Сериал' : 'Фильм';
		$('heroTitle').innerHTML = esc(it.title);
		$('heroMeta').innerHTML = metaLine(it);
		$('heroPlot').innerHTML = esc(it.plot);
		var d = '';
		for (var i = 0; i < DATA.hero.length; i++) d += '<span class="dot' + (i === Home.hero ? ' on' : '') + '"></span>';
		$('dots').innerHTML = d;
		clearTimeout(Home.timer);
		Home.timer = setTimeout(function () { if (Page.cur === 'home' && Home.zone !== 'row') Home.showHero(Home.hero + 1); }, 9000);
	},

	// Focus and scrolling: the column slides so the focused shelf sits under the top edge.
	focus: function () {
		var i, inRows = Home.zone === 'row';
		for (i = 0; i < Home.TABS.length; i++) setClass('tab' + i, 'focus', Home.zone === 'tabs' && i === Home.tab);
		setClass('hb0', 'focus', Home.zone === 'hero' && Home.btn === 0);
		setClass('hb1', 'focus', Home.zone === 'hero' && Home.btn === 1);
		setClass('tabs', 'away', inRows);
		var y = 0;
		if (inRows) {
			y = 380;
			for (i = 0; i < Home.r; i++) y += DATA.rows[i].kind === 'poster' ? 268 : 200;
			y = -(y - 40);
		}
		move($('column'), 0, y);
	},

	focusCard: function (r, on) {
		var row = Home.rows[r];
		setClass('c' + r + '_' + row.idx, 'focus', on);
		if (!on) return;
		var c = CARD[row.kind], x = row.idx * (c.w + c.gap);
		// keep the card (and its 10 % lift) inside the safe area
		if (x - row.off > VIEW - c.w - 20) row.off = x - (VIEW - c.w - 20);
		if (x - row.off < 0) row.off = x;
		move($('row' + r), -row.off, 0);
	},

	key: function (k) {
		var row = Home.rows[Home.r];
		if (Home.zone === 'tabs') {
			if (k === K.LEFT && Home.tab > 0) Home.tab--;
			else if (k === K.RIGHT && Home.tab < Home.TABS.length - 1) Home.tab++;
			else if (k === K.DOWN) Home.zone = 'hero';
			else if (k === K.ENTER) { if (Home.tab) toast('Это прототип: работает только «Смотреть»'); }
			Home.focus();
			return;
		}
		if (Home.zone === 'hero') {
			if (k === K.UP) Home.zone = 'tabs';
			else if (k === K.DOWN) { Home.zone = 'row'; Home.r = 0; Home.focusCard(0, true); }
			else if (k === K.LEFT) { if (Home.btn > 0) Home.btn--; else Home.showHero(Home.hero - 1); }
			else if (k === K.RIGHT) { if (Home.btn < 1) Home.btn++; else Home.showHero(Home.hero + 1); }
			else if (k === K.ENTER || k === K.PLAY) {
				if (Home.btn === 0) toast('Это прототип: видео не запускается');
				else Detail.open(DATA.hero[Home.hero]);
				return;
			}
			Home.focus();
			return;
		}
		// shelves
		if (k === K.LEFT && row.idx > 0) { Home.focusCard(Home.r, false); row.idx--; Home.focusCard(Home.r, true); }
		else if (k === K.RIGHT && row.idx < row.ids.length - 1) { Home.focusCard(Home.r, false); row.idx++; Home.focusCard(Home.r, true); }
		else if (k === K.UP || k === K.DOWN || k === K.RETURN) {
			Home.focusCard(Home.r, false);
			if (k === K.RETURN) { Home.zone = 'tabs'; Home.r = 0; }
			else if (k === K.UP && Home.r === 0) Home.zone = 'hero';
			else if (k === K.UP) Home.r--;
			else if (Home.r < Home.rows.length - 1) Home.r++;
			if (Home.zone === 'row') Home.focusCard(Home.r, true);
			Home.focus();
		}
		else if (k === K.ENTER || k === K.PLAY) Detail.open(row.ids[row.idx]);
	}
};

/* ---------- detail ---------- */

var Detail = {
	id: null, zone: 'btns', btn: 0, idx: 0, off: 0, list: [],

	open: function (id) {
		var it = item(id);
		Detail.id = id; Detail.zone = 'btns'; Detail.btn = 0; Detail.idx = 0; Detail.off = 0;
		$('dbg').src = it.bg;
		$('dTitle').innerHTML = esc(it.title);
		$('dOrig').innerHTML = esc(it.orig);
		$('dMeta').innerHTML = metaLine(it);
		var rt = '';
		if (it.kp) rt += '<span>Кинопоиск ' + (+it.kp).toFixed(1) + '</span>';
		if (it.imdb) rt += '<span>IMDb ' + (+it.imdb).toFixed(1) + '</span>';
		$('dRatings').innerHTML = rt;
		$('dPlot').innerHTML = esc(it.plot);
		$('db0').innerHTML = '&#9654;&nbsp; ' + (it.progress ? 'Продолжить' : 'Смотреть');
		// series: the first season's episodes; films: more like this
		var h;
		if (it.eps) {
			Detail.list = it.eps.episodes;
			h = '<div class="shelf"><h2>Сезон 1</h2><div class="row" id="drow">';
			for (var i = 0; i < Detail.list.length; i++) {
				var e = Detail.list[i];
				h += '<div class="ep" id="d' + i + '" style="left:' + (i * 220) + 'px"><div class="n">Серия ' + e.n + '</div>' +
					'<div class="t">' + esc(e.t || 'Серия ' + e.n) + '</div><div class="d">' + (e.d ? Math.round(e.d / 60) + ' мин' : '') + '</div></div>';
			}
		} else {
			Detail.list = [];
			for (var key in DATA.items) if (key !== String(id) && !DATA.items[key].eps && Detail.list.length < 10) Detail.list.push(DATA.items[key]);
			h = '<div class="shelf poster"><h2>Похожее</h2><div class="row" id="drow">';
			for (var j = 0; j < Detail.list.length; j++)
				h += '<div class="card poster" id="d' + j + '" style="left:' + (j * 150) + 'px"><div class="art"><img src="' + Detail.list[j].p + '" />' +
					'<div class="shine"></div></div><div class="cap">' + esc(Detail.list[j].title) + '</div></div>';
		}
		$('more').innerHTML = h + '</div></div>';
		Page.show('detail');
		Detail.focus();
	},

	focus: function () {
		for (var b = 0; b < 3; b++) setClass('db' + b, 'focus', Detail.zone === 'btns' && b === Detail.btn);
		var down = Detail.zone === 'more';
		move($('dInfo'), 0, down ? -110 : 0);
		move($('more'), 0, down ? -205 : -60);
		for (var i = 0; i < Detail.list.length; i++) setClass('d' + i, 'focus', down && i === Detail.idx);
		var w = Item_w(), x = Detail.idx * w;
		if (x - Detail.off > VIEW - w) Detail.off = x - (VIEW - w);
		if (x - Detail.off < 0) Detail.off = x;
		if ($('drow')) move($('drow'), -Detail.off, 0);
	},

	key: function (k) {
		if (k === K.RETURN) { Page.show('home'); return; }
		if (Detail.zone === 'btns') {
			if (k === K.LEFT && Detail.btn > 0) Detail.btn--;
			else if (k === K.RIGHT && Detail.btn < 2) Detail.btn++;
			else if (k === K.DOWN) Detail.zone = 'more';
			else if (k === K.ENTER || k === K.PLAY) { toast(['Это прототип: видео не запускается', 'Трейлер появится в настоящем приложении', 'Добавлено в «Посмотреть» (понарошку)'][Detail.btn]); return; }
		} else {
			if (k === K.UP) Detail.zone = 'btns';
			else if (k === K.LEFT && Detail.idx > 0) Detail.idx--;
			else if (k === K.RIGHT && Detail.idx < Detail.list.length - 1) Detail.idx++;
			else if (k === K.ENTER || k === K.PLAY) {
				if (Detail.list[Detail.idx].id) { Detail.open(Detail.list[Detail.idx].id); return; }
				toast('Это прототип: видео не запускается');
				return;
			}
		}
		Detail.focus();
	}
};
function Item_w() { return item(Detail.id).eps ? 220 : 150; }

/* ---------- pages ---------- */

var Page = {
	cur: 'home',
	show: function (name) {
		Page.cur = name;
		setClass('home', 'on', name === 'home');
		setClass('detail', 'on', name === 'detail');
	}
};

var App = {
	init: function () {
		if (widgetAPI) widgetAPI.sendReadyEvent();
		$('anchor').focus();
		if (!tvKey) document.onkeydown = function (e) {
			e = e || window.event;
			if ((e.target || e.srcElement) !== $('anchor')) App.onKey(e);
		};
		Home.build();
		Page.show('home');
	},
	onKey: function (e) {
		var k = e.keyCode;
		if (k === K.RETURN && widgetAPI) widgetAPI.blockNavigation(e);
		if (!tvKey && k === 8 && e.preventDefault) e.preventDefault();
		if (Page.cur === 'home') Home.key(k); else Detail.key(k);
	}
};
