/* Job Ops console: intake, match, rewrite, copy. No network, no storage of
   resume text — only the chosen database and the pushed-job fingerprints are
   persisted, both locally. */
(function () {
  'use strict';

  var E = window.JOEngine;
  var LS_DB = 'jobops.db.v1';
  var LS_PUSHED = 'jobops.pushed.v2';
  /* A WeChat conversation on a 390x844 screen leaves roughly this much room
     for one bubble before the reader must scroll. Measured in CSS pixels. */
  var BUBBLE_BUDGET = 600;

  var state = {
    jobs: [],
    source: {name: '', rows: 0, loaded: '', custom: false},
    index: null,
    profile: null,
    scored: [],
    current: 0,
    tailoredFor: -1
  };

  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1800);
  }

  /* ------------------------------------------------------------ database */

  function sheetRows(wb) {
    var best = null, bestLen = 0;
    wb.SheetNames.forEach(function (name) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {defval: '', raw: false});
      if (rows.length > bestLen) { best = rows; bestLen = rows.length; }
    });
    return {rows: best || [], sheet: bestLen};
  }

  function colName(obj, candidates, includes) {
    var keys = Object.keys(obj);
    for (var i = 0; i < candidates.length; i++) {
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] === candidates[i]) return keys[k];
      }
    }
    if (includes) {
      for (var j = 0; j < includes.length; j++) {
        for (var m = 0; m < keys.length; m++) {
          if (keys[m].indexOf(includes[j]) >= 0) return keys[m];
        }
      }
    }
    return null;
  }

  /* Map a spreadsheet of any vintage onto the four fields the engine needs.
     Missing columns degrade to empty strings rather than failing the import. */
  function jobsFromRows(rows) {
    if (!rows.length) return [];
    var kT = colName(rows[0], ['岗位', '职位', '岗位名称', '职位名称'], ['岗位', '职位']);
    var kC = colName(rows[0], ['公司', '公司名称', '企业'], ['公司', '企业']);
    if (!kT || !kC) return [];
    var kLoc = colName(rows[0], ['工作地点', '地点', '城市', 'base'], ['地点', '城市']);
    var kPay = colName(rows[0], ['薪资', '薪水', '工资'], ['薪']);
    var kSched = colName(rows[0], ['实习安排', '出勤', '实习时间'], ['安排', '出勤']);
    var kEdu = colName(rows[0], ['经验学历', '学历', '学历要求'], ['学历']);
    var kAct = colName(rows[0], ['招聘者与活跃', '活跃', '招聘者'], ['活跃', '招聘者']);
    var kJd = colName(rows[0], ['JD原文', 'JD', '职位描述', '岗位描述', '工作内容'], ['JD', '描述']);

    var out = [];
    rows.forEach(function (r) {
      var t = String(r[kT] || '').trim();
      var c = String(r[kC] || '').trim();
      if (!t || !c) return;
      out.push({
        t: t, c: c,
        loc: String(r[kLoc] || '').trim(),
        pay: String(r[kPay] || '').trim() || '平台未提供',
        sched: String(r[kSched] || '').trim(),
        edu: String(r[kEdu] || '').trim(),
        act: String(r[kAct] || '').trim(),
        jd: String(r[kJd] || '').trim(),
        jdLen: String(r[kJd] || '').trim().length
      });
    });
    return out;
  }

  function setDb(jobs, source) {
    state.jobs = jobs;
    state.source = source;
    state.index = E.buildIndex(jobs);
    $('statPool').textContent = String(jobs.length);
    $('emptyPool').textContent = String(jobs.length);
    $('dbmeta').innerHTML = '<strong>' + esc(source.name) + '</strong><br>' +
      jobs.length + ' 个岗位 · 载入 ' + esc(source.loaded) +
      (source.custom ? ' · <strong>自定义版</strong>' : ' · 内置版');
    $('dbnote').textContent = '';
  }

  function loadDb() {
    var base = {
      name: (window.JOB_DB && window.JOB_DB.meta && window.JOB_DB.meta.source) || '内置数据库',
      loaded: (window.JOB_DB && window.JOB_DB.meta && window.JOB_DB.meta.loaded) || '',
      custom: false
    };
    var custom = null;
    try { custom = JSON.parse(localStorage.getItem(LS_DB) || 'null'); } catch (e) { custom = null; }
    if (custom && custom.jobs && custom.jobs.length) {
      setDb(custom.jobs, {
        name: custom.name || '自定义数据库', loaded: custom.loaded || '', custom: true
      });
      $('dbnote').textContent = '正在使用你上次导入的版本。点「恢复内置版」退回。';
      return;
    }
    var jobs = (window.JOB_DB && window.JOB_DB.jobs) || [];
    setDb(jobs, base);
  }

  function importDb(file) {
    readArrayBuffer(file).then(function (buf) {
      var wb = XLSX.read(buf, {type: 'array'});
      var res = sheetRows(wb);
      var jobs = jobsFromRows(res.rows);
      if (!jobs.length) {
        $('dbnote').textContent = '没读到「岗位」「公司」两列，这版表头对不上，数据库没换。';
        return;
      }
      var payload = {
        name: file.name,
        loaded: new Date().toISOString().slice(0, 10),
        jobs: jobs
      };
      try {
        localStorage.setItem(LS_DB, JSON.stringify(payload));
      } catch (e) {
        $('dbnote').textContent = '新库有 ' + jobs.length + ' 行，超出浏览器本地存储上限，这次只在当前页面生效。';
      }
      setDb(jobs, {name: payload.name, loaded: payload.loaded, custom: true});
      if (state.profile) rematch();
      toast('数据库已换成 ' + jobs.length + ' 个岗位');
    }).catch(function (err) {
      $('dbnote').textContent = '读不了这个文件：' + (err && err.message ? err.message : '格式不支持');
    });
  }

  /* -------------------------------------------------------------- intake */

  function readArrayBuffer(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function readText(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result || '')); };
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }

  var pdfReady = false;
  function initPdf() {
    if (pdfReady || !window.pdfjsLib) return;
    /* Fake-worker mode: pdf.worker is loaded as a plain script above, so the
       document is parsed on the main thread with no cross-origin worker file. */
    if (window.pdfjsWorker && window.pdfjsLib.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    pdfReady = true;
  }

  function pdfText(buf) {
    initPdf();
    return window.pdfjsLib.getDocument({data: buf, isEvalSupported: false}).promise.then(function (doc) {
      var pages = [];
      var chain = Promise.resolve();
      for (var i = 1; i <= doc.numPages; i++) {
        chain = chain.then(function (p) {
          return doc.getPage(p).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var line = [];
              tc.items.forEach(function (it) {
                line.push(it.str);
                if (it.hasEOL) line.push('\n');
              });
              pages.push(line.join(''));
            });
          });
        }.bind(null, i));
      }
      return chain.then(function () { return pages.join('\n'); });
    });
  }

  function docxText(buf) {
    return JSZip.loadAsync(buf).then(function (zip) {
      var f = zip.file('word/document.xml');
      if (!f) throw new Error('docx 里没找到正文');
      return f.async('string');
    }).then(function (xml) {
      return xml
        .replace(/<w:p[ >]/g, '\n<w:p ')
        .replace(/<w:tab\/>/g, ' ')
        .replace(/<w:br\/>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    });
  }

  function xlsxText(buf) {
    var wb = XLSX.read(buf, {type: 'array'});
    var out = [];
    wb.SheetNames.forEach(function (n) {
      out.push(XLSX.utils.sheet_to_csv(wb.Sheets[n], {blankrows: false}));
    });
    return Promise.resolve(out.join('\n'));
  }

  function extract(file) {
    var name = file.name.toLowerCase();
    if (/\.pdf$/.test(name)) {
      if (!window.pdfjsLib) return Promise.reject(new Error('PDF 组件没加载'));
      return readArrayBuffer(file).then(pdfText);
    }
    if (/\.docx$/.test(name)) {
      if (!window.JSZip) return Promise.reject(new Error('docx 组件没加载'));
      return readArrayBuffer(file).then(docxText);
    }
    if (/\.(xlsx|xls)$/.test(name)) return readArrayBuffer(file).then(xlsxText);
    return readText(file);
  }

  var DEMO = '林小满\n' +
    '求职意向：产品实习生（AI / 数据方向）｜ 杭州 ｜ 13800138000 ｜ linxiaoman@example.com\n' +
    '教育背景\n' +
    '浙江工商大学 信息管理与信息系统 本科 2023.09–2027.06（2027 届）\n' +
    '主修课程：数据库原理、数据结构、统计学、管理信息系统；GPA 3.6/4.0，专业前 15%\n' +
    '实习经历\n' +
    '杭州知微科技有限公司 · 产品助理（实习） 2025.07–2025.09\n' +
    '• 负责校园二手交易小程序的用户调研，完成 32 份深度访谈，输出需求文档与原型 14 个页面\n' +
    '• 参与埋点方案设计，梳理 26 个关键事件，搭建周报看板，帮助运营定位注册流失环节\n' +
    '• 协助跟进版本验收，累计提交 48 条缺陷，推动首月活跃用户从 1200 提升到 3100\n' +
    '浙江工商大学 电子商务实验室 · 项目负责人 2024.10–2025.05\n' +
    '• 带队 4 人完成校园团购小程序，用 Axure 输出完整原型，SQL 独立完成订单与品类分析\n' +
    '• 项目获校级创新创业大赛二等奖，累计服务 800+ 名学生用户\n' +
    '技能\n' +
    'Axure、Figma、SQL、Python（Pandas 基础）、Excel 数据透视、Tableau 基础；英语 CET-6（542）\n' +
    '熟悉大模型应用（提示词设计、RAG 基础流程），有 Vibe Coding 实践：用 Cursor 独立完成数据看板 demo\n' +
    '自我评价\n' +
    '对数据敏感，逻辑清晰，能独立推动跨部门协作；每周可到岗 5 天，可连续实习 6 个月以上。';

  function ingestText(text, label) {
    if (!text || text.replace(/\s+/g, '').length < 30) {
      toast('这份内容太短，读不出简历');
      return;
    }
    var t0 = performance.now();
    var profile = E.parseResume(text);
    profile.sourceLabel = label || '';
    state.profile = profile;
    state.tailoredFor = -1;
    fillFacts(profile);
    $('factsBlock').hidden = false;
    rematch(t0);
  }

  function rematch(t0) {
    var start = t0 || performance.now();
    var keepKey = state.scored[state.current] ? keyOf(state.scored[state.current].job) : '';
    var scored = E.match(state.profile, state.jobs, state.index);
    state.scored = scored;
    /* Keep the posting the operator is looking at if it survived the re-score;
       otherwise fall back to the best one not yet pushed. */
    var keepIdx = -1;
    if (keepKey) {
      for (var i = 0; i < scored.length; i++) {
        if (keyOf(scored[i].job) === keepKey) { keepIdx = i; break; }
      }
    }
    state.current = keepIdx >= 0 ? keepIdx : pickRecommended(scored, '');
    var ms = Math.round(performance.now() - start);
    $('statMs').textContent = ms + 'ms';
    $('result').hidden = false;
    $('empty').hidden = true;
    render();
  }

  /* A person is identified by what the operator would say out loud — name plus
     one stable fact — so the same person coming back tomorrow is recognised
     and a different person with the same name is not. No identity is stored
     for anyone who is never pushed a job. */
  function whoOf(profile) {
    var p = profile || {};
    var name = (p.name || '').replace(/\s+/g, '');
    var ed = (p.school || '') + (p.gradYear || '');
    if (!name && !ed) return '未署名';
    return name + '@' + ed;
  }

  /* Push memory is per person: keying only on company|role would let one
     candidate's push withhold that posting from every other candidate. */
  function keyOf(job) { return whoOf(state.profile) + '|' + job.c + '|' + job.t; }

  function pushedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_PUSHED) || '[]')); } catch (e) { return new Set(); }
  }

  function markPushed(job) {
    var s = pushedSet();
    s.add(keyOf(job));
    try { localStorage.setItem(LS_PUSHED, JSON.stringify(Array.from(s))); } catch (e) { /* ignore */ }
  }

  /* Today's pick: the best scoring job that has not already been pushed to this
     person. Hard-failed jobs never get the slot while a viable one exists. */
  function pickRecommended(scored, excludeKey) {
    var pushed = pushedSet();
    for (var i = 0; i < scored.length; i++) {
      if (scored[i].hardFail) continue;
      var k = keyOf(scored[i].job);
      if (k === excludeKey) continue;
      if (!pushed.has(k)) return i;
    }
    for (var j = 0; j < scored.length; j++) {
      if (!scored[j].hardFail && keyOf(scored[j].job) !== excludeKey) return j;
    }
    return 0;
  }

  /* --------------------------------------------------------------- facts */

  function fillFacts(p) {
    $('fName').value = p.name || '';
    $('fSchool').value = p.school || '';
    $('fMajor').value = p.major || '';
    $('fDegree').value = p.degree || '';
    $('fYear').value = p.gradYear || '';
    $('fCity').value = p.city || '';
    $('fDays').value = p.weeklyDays || '';
    $('fMonths').value = p.months || '';
    var got = [p.gradYear ? p.gradYear + ' 届' : '', p.degree, p.school, p.major].filter(Boolean);
    var miss = [];
    if (!p.name) miss.push('姓名');
    if (!p.gradYear) miss.push('毕业年份');
    if (!p.weeklyDays) miss.push('每周到岗天数');
    if (!p.months) miss.push('可实习月数');
    $('factsNote').innerHTML = miss.length
      ? '读到了：' + esc(got.join(' · ') || '（只有正文）') + '。<b>缺 ' + esc(miss.join('、')) + '</b>，这两项直接决定能不能投，补上再匹配。'
      : '读到了：' + esc(got.join(' · ')) + '，可到岗 ' + p.weeklyDays + ' 天/周、连续 ' + p.months + ' 个月。有出入就在这里改。';
  }

  function applyFacts() {
    var p = state.profile;
    if (!p) return;
    p.name = $('fName').value.trim();
    p.school = $('fSchool').value.trim();
    p.major = $('fMajor').value.trim();
    p.degree = $('fDegree').value.trim();
    var y = parseInt($('fYear').value, 10);
    p.gradYear = isNaN(y) ? 0 : y;
    p.city = $('fCity').value.trim();
    var d = parseInt($('fDays').value, 10);
    p.weeklyDays = isNaN(d) ? 0 : d;
    var m = parseInt($('fMonths').value, 10);
    p.months = isNaN(m) ? 0 : m;
    state.tailoredFor = -1;
    $('tailor').innerHTML = '';
    rematch();
  }

  /* -------------------------------------------------------------- render */

  function render() {
    renderPick();
    renderMessage();
    renderList();
    if (state.tailoredFor === state.current) renderTailor();
  }

  function renderPick() {
    var s = state.scored[state.current];
    if (!s) { $('pickCard').innerHTML = ''; return; }
    var job = s.job;
    var pairs = (s.pairs || []).slice(0, 3);
    var meta = [];
    if (job.pay && job.pay !== '平台未提供') meta.push('<span>日薪<b>' + esc(job.pay) + '</b></span>');
    if (job.sched) meta.push('<span>出勤<b>' + esc(shortSched(job.sched)) + '</b></span>');
    if (job.edu) meta.push('<span>学历<b>' + esc(job.edu.replace(/^学历/, '')) + '</b></span>');
    if (job.act) meta.push('<span>招聘者<b>' + esc(job.act) + '</b></span>');

    var gates = (s.gates || []).filter(function (g) { return g.level !== 'info'; });
    var gateHtml = gates.length
      ? '<div class="gate-note">' + gates.map(function (g) {
        return esc(g.level === 'hard' ? '硬条件不合：' : '需要先对一下：') + esc(g.text) + '。';
      }).join('<br>') + '</div>'
      : '';

    $('pickCard').innerHTML =
      '<div class="stamp">今日<br>一岗</div>' +
      '<div class="pick-kicker"><span>今天只跟这一个</span><span class="dot"></span><span>' +
        esc(s.family) + '方向</span></div>' +
      '<div class="pick-title">' + esc(job.t) + '</div>' +
      '<div class="pick-company">' + esc(job.c) + (job.loc ? ' · ' + esc(job.loc) : '') + '</div>' +
      '<div class="pick-meta">' + meta.join('') + '</div>' +
      '<div class="pick-why">' + (pairs.length ? pairs.map(function (p, i) {
        return '<div class="why-row"><span class="n">' + (i + 1) + '</span><div>' +
          '<q>' + esc(p.req) + '</q><br><span class="ev">你简历：' + esc(p.ev) + '</span></div></div>';
      }).join('') : '<div class="why-row"><span class="n">·</span><div>这个岗和他的经历没有可直接引用的重合句，只能靠通用条件推，说服力弱，建议换一个。</div></div>') +
      '</div>' + gateHtml +
      '<div class="pick-actions">' +
        '<button class="btn sm stamp" id="copyMsg2">复制发给他的话</button>' +
        '<button class="btn sm btn-ghost" id="markPush">记下今天推过它</button>' +
        '<span class="pick-score">' + s.score + ' 分，95 为排序上限</span>' +
      '</div>';

    $('copyMsg2').onclick = copyMessage;
    $('markPush').onclick = function () {
      markPushed(job);
      toast('已记为今天推过，明天不会再推它');
      renderList();
    };
  }

  function shortSched(s) {
    var t = String(s || '');
    var days = (t.match(/([1-7])\s*天\/周/) || [])[1];
    var months = (t.match(/时长\s*(\d{1,2})\s*个月/) || [])[1];
    if (days && months) return days + ' 天/周 · ' + months + ' 个月';
    return t.replace(/^实习\s*/, '') || '面议';
  }

  function renderMessage() {
    var s = state.scored[state.current];
    if (!s) return;
    var rw = E.rewrite(state.profile, s);
    var pairs = (s.pairs || []).slice(0, 3);
    var text = '';
    var n = pairs.length;
    /* Fit to one bubble: drop the weakest pair rather than letting the reader
       scroll. The operator can still see the dropped pair in the card above. */
    for (; n >= 1; n--) {
      text = E.buildMessage(state.profile, withPairs(s, pairs.slice(0, n)), rw);
      setMsg(text);
      if ($('msg').scrollHeight <= BUBBLE_BUDGET) break;
    }
    if (n < 1) {
      text = E.buildMessage(state.profile, withPairs(s, []), rw);
      setMsg(text);
    }
    var h = $('msg').scrollHeight;
    var tag = $('fitTag');
    if (h <= BUBBLE_BUDGET) {
      tag.textContent = '整屏可见 ' + h + '/' + BUBBLE_BUDGET;
      tag.className = 'fit';
    } else {
      tag.textContent = '超出 ' + h + '/' + BUBBLE_BUDGET;
      tag.className = 'over';
    }
    $('msgLen').textContent = text.length + ' 字 · ' + (text.split('\n').length) + ' 行';
  }

  function withPairs(s, pairs) {
    var copy = {};
    for (var k in s) copy[k] = s[k];
    copy.pairs = pairs;
    return copy;
  }

  function setMsg(text) {
    $('msg').textContent = text;
  }

  function currentMessageText() { return $('msg').textContent; }

  function copyMessage() {
    copyText(currentMessageText(), '这段话已复制，粘到企微发给本人');
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
    document.body.removeChild(ta);
  }

  function renderList() {
    var pushed = pushedSet();
    var rows = [];
    state.scored.slice(0, 40).forEach(function (s, i) {
      var isPushed = pushed.has(keyOf(s.job));
      var cur = i === state.current;
      var cls = 'row' + (cur ? ' cur' : '') + (isPushed && !cur ? ' done' : '');
      var tag = s.hardFail ? '不合' : (isPushed ? '已推' : (s.pairs.length >= 2 ? '可讲' : '勉强'));
      rows.push('<button class="' + cls + '" data-i="' + i + '">' +
        '<span class="rk">' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(s.job.t) + '<em>' + esc(s.job.c) + '</em></span>' +
        '<span class="sc' + (s.score < 60 ? ' low' : '') + '">' + s.score + '</span>' +
        '<span class="tg' + (s.hardFail ? ' warn' : '') + '">' + tag + '</span>' +
        '</button>');
    });
    $('list').innerHTML = rows.join('');
    Array.prototype.forEach.call($('list').querySelectorAll('.row'), function (el) {
      el.onclick = function () {
        state.current = parseInt(el.getAttribute('data-i'), 10);
        state.tailoredFor = -1;
        $('tailor').innerHTML = '';
        render();
        window.scrollTo({top: 0, behavior: 'smooth'});
      };
    });
    $('listHint').textContent = '显示前 40 / 共 ' + state.scored.length + ' 个';
  }

  /* ------------------------------------------------------------- tailor */

  function renderTailor() {
    var s = state.scored[state.current];
    if (!s || !state.profile) return;
    var rw = E.rewrite(state.profile, s);
    var p = state.profile;
    var job = s.job;

    var head = [p.name, p.phone, p.email].filter(Boolean).join(' ｜ ');
    var bullets = rw.bullets.slice(0, 6).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('');
    var numOk = rw.numberCheck.ok;

    var changes = rw.changes.map(function (c) {
      return '<div class="chg"><span class="w">' + esc(c.what) + '</span><div>' + esc(c.detail) + '</div></div>';
    }).join('');

    var greet = greeting(p, s);

    $('tailor').innerHTML =
      '<div class="tailored">' +
        '<div class="tailored-h"><span>按「' + esc(job.c) + ' · ' + esc(job.t) + '」重排的版本</span>' +
        '<span class="t">事实未改</span></div>' +
        '<div class="resume-body">' +
          '<h3>' + esc(p.name || '（未读到姓名）') + '</h3>' +
          '<div class="resume-head">' + esc(rw.headline) + '</div>' +
          (head ? '<div style="font-size:12px;color:#7d8794;margin-bottom:10px">' + esc(head) + '</div>' : '') +
          '<p class="sum">' + esc(rw.summary) + '</p>' +
          '<ul>' + bullets + '</ul>' +
          '<div class="skl">技能：' + esc(rw.skillLine) + '</div>' +
        '</div>' +
        '<div class="changes">' +
          '<div class="changes-h">改了什么（共 ' + rw.changes.length + ' 处）</div>' + changes +
          '<div class="chg keep"><span class="w">数字核对</span><div>' +
            (numOk
              ? '改后出现的 ' + rw.numberCheck.kept.length + ' 个数字全部来自原简历，没有新造。'
              : '有 ' + rw.numberCheck.added.length + ' 个数字不在原稿里（' + esc(rw.numberCheck.added.join('、')) + '），先别发，回去核对。') +
          '</div></div>' +
        '</div>' +
        '<div class="greet">' +
          '<div class="cap"><span>BOSS 打招呼首句</span><span class="rule">复制后到 BOSS 自己发</span></div>' +
          '<p>' + esc(greet) + '</p>' +
          '<button class="btn sm" id="copyGreet" style="margin-top:8px">复制首句</button>' +
        '</div>' +
      '</div>';

    $('copyGreet').onclick = function () { copyText(greet, '首句已复制。发送键在你手上，我们不代按'); };
    state.tailoredFor = state.current;
  }

  /* The opener must be about this posting's own wording, never a generic
     template, and must never claim anything the resume does not say. */
  function greeting(p, s) {
    var top = (s.pairs || [])[0];
    var tag = [p.gradYear ? p.gradYear + ' 届' : '', p.degree, p.major].filter(Boolean).join(' ');
    var bits = ['您好，我是' + (p.name || '') + (tag ? '，' + tag : '') + '。'];
    if (top) {
      bits.push('看到岗位要求里提到「' + E.trimReq(top.req) + '」，我在' + placeOf(top.ev) + '做过' + coreOf(top.ev) + '。');
    }
    var avail = [];
    if (p.weeklyDays) avail.push('每周可到岗 ' + p.weeklyDays + ' 天');
    if (p.months) avail.push('可连续实习 ' + p.months + ' 个月');
    if (avail.length) bits.push(avail.join('，') + '，可以尽快到岗。');
    return bits.join('');
  }

  function placeOf(ev) {
    var m = String(ev).match(/^在?([^，,。]{2,18})(?:的|中|内)/);
    return m ? m[1] : '实习里';
  }

  function coreOf(ev) {
    var t = String(ev).replace(/^负责|^参与|^协助|^独立/, '');
    var cut = t.search(/[，,。；]/);
    return cut > 4 ? t.slice(0, cut) : t.slice(0, 28);
  }

  /* ---------------------------------------------------------------- wire */

  function bind() {
    var drop = $('drop');
    var fileInput = $('file');

    $('pick').onclick = function () { fileInput.click(); };
    drop.onclick = function (e) { if (e.target === drop) fileInput.click(); };
    fileInput.onchange = function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); };

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $('run').onclick = function () {
      var pasted = $('paste').value.trim();
      if (state.profile) { applyFacts(); toast('已按修改后的事实重新匹配'); return; }
      if (!pasted) { toast('先丢一份简历，或粘贴正文'); return; }
      ingestText(pasted, '粘贴内容');
    };

    $('demo').onclick = function () {
      $('paste').value = DEMO;
      ingestText(DEMO, '示例简历');
    };

    ['fName', 'fSchool', 'fMajor', 'fDegree', 'fYear', 'fCity', 'fDays', 'fMonths'].forEach(function (id) {
      var el = $(id);
      el.addEventListener('change', applyFacts);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') applyFacts(); });
    });

    $('newPerson').onclick = function () {
      state.profile = null;
      state.scored = [];
      state.current = 0;
      state.tailoredFor = -1;
      $('paste').value = '';
      $('factsBlock').hidden = true;
      $('tailor').innerHTML = '';
      $('result').hidden = true;
      $('empty').hidden = false;
      toast('清空了，丢下一份简历进来');
      window.scrollTo({top: 0, behavior: 'smooth'});
    };

    $('copyMsg').onclick = copyMessage;

    $('confirm').onclick = function () {
      renderTailor();
      markPushed(state.scored[state.current].job);
      renderList();
      var el = $('tailor');
      if (el && el.scrollIntoView) el.scrollIntoView({behavior: 'smooth', block: 'start'});
    };

    $('next').onclick = function () {
      var cur = state.scored[state.current];
      var curKey = cur ? keyOf(cur.job) : '';
      if (cur) markPushed(cur.job);
      state.current = pickRecommended(state.scored, curKey);
      state.tailoredFor = -1;
      $('tailor').innerHTML = '';
      render();
      toast('已跳过当前这个，换到下一个没推过的岗');
    };

    $('dbPick').onclick = function () { $('dbfile').click(); };
    $('dbfile').onchange = function () {
      if ($('dbfile').files[0]) importDb($('dbfile').files[0]);
    };
    $('dbReset').onclick = function () {
      try { localStorage.removeItem(LS_DB); } catch (e) { /* ignore */ }
      loadDb();
      if (state.profile) rematch();
      toast('已恢复内置版本');
    };
  }

  function handleFile(file) {
    if (file.size > 5 * 1024 * 1024) { toast('文件超过 5MB，先用粘贴'); return; }
    var t0 = performance.now();
    extract(file).then(function (text) {
      if (!text || text.replace(/\s+/g, '').length < 30) {
        toast('没读到文字。扫描件或图片简历请用粘贴');
        return;
      }
      ingestText(text, file.name + ' · ' + Math.round(performance.now() - t0) + 'ms');
      $('paste').value = '';
    }).catch(function (err) {
      toast('解析失败：' + (err && err.message ? err.message : '未知错误') + '，改用粘贴');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    loadDb();
    $('statSend').textContent = '0';
    /* Read-only handle for the QA harness and for poking at the engine in a
       console. Nothing here writes outside the page. */
    window.__OPS__ = state;
    window.__OPS__.demoText = DEMO;
    if (window.__OPS_AUTORUN__) {
      $('paste').value = DEMO;
      ingestText(DEMO, '示例简历');
    }
  });
})();
