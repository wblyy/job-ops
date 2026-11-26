/* Job Ops · deterministic matching engine.
   No network calls, no LLM: every claim it produces is either a JD clause or a
   sentence already present in the candidate's resume. Exposed as window.JOEngine. */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ text */

  var STOP_CHARS = '的了和与及在对有是等把被为而就都很也还要从到这个那个我们你们他们可以需要进行负责参与协助相关工作内容岗位职责任职要求同学欢迎投递优先良好具备能力以及更加一些如果能够或者什么怎么如何目前现在今天时间地点公司团队项目业务部门能力';

  /* Display copy keeps the text as written. Matching folds a separate NFKC view
     because the source spreadsheet contains compatibility forms. */
  function normalize(s) {
    if (!s) return '';
    return String(s)
      .replace(/\r/g, '\n')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* Matching view: compatibility-folded, so ＡＢＣ／（） compare equal to their
     half-width forms regardless of which side they came from. */
  function fold(s) {
    var t = normalize(s);
    return t.normalize ? t.normalize('NFKC') : t;
  }

  /* Collapse the stray spaces PDF extraction leaves between Han characters. */
  function tighten(s) {
    return fold(s).replace(/([一-鿿]) (?=[一-鿿])/g, '$1');
  }

  var CJK = /[一-鿿]/;

  /* The DB is NFKC-normalised, which turns ，：；！？ into ASCII. Candidate-facing
     copy must read like written Chinese again, so restore punctuation whenever
     it sits next to a Han character (never inside 180,000). */
  function punct(s) {
    var map = { ',': '，', ':': '：', ';': '；', '?': '？', '!': '！', '(': '（', ')': '）' };
    var t = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (map[ch]) {
        var prev = i > 0 ? t[i - 1] : '';
        var next = i + 1 < t.length ? t[i + 1] : '';
        if (CJK.test(prev) || CJK.test(next)) ch = map[ch];
      }
      out += ch;
    }
    return out;
  }

  /* Bigrams over CJK runs plus lowercase latin/digit words. Cheap and good
     enough for Chinese keyword overlap without a segmentation dictionary. */
  function tokens(text) {
    var t = tighten(String(text || '')).toLowerCase();
    var out = Object.create(null);
    var latin = t.match(/[a-z][a-z0-9+#.\/-]{1,20}/g) || [];
    for (var i = 0; i < latin.length; i++) out[latin[i]] = 1;
    var runs = t.match(/[一-鿿]+/g) || [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      for (var k = 0; k < run.length - 1; k++) {
        var bg = run.slice(k, k + 2);
        if (STOP_CHARS.indexOf(bg[0]) >= 0 && STOP_CHARS.indexOf(bg[1]) >= 0) continue;
        out[bg] = 1;
      }
      if (run.length === 1) out[run] = 1;
    }
    return Object.keys(out);
  }

  var NUM_RE = /\d+(?:\.\d+)?\s*(?:%|％|天|周|月|年|个|页|份|人|条|次|倍|万|千|k|K|元|小时|h|H)?/g;

  function numbersIn(s) {
    var m = String(s || '').match(NUM_RE) || [];
    var set = Object.create(null);
    for (var i = 0; i < m.length; i++) {
      var v = m[i].replace(/\s+/g, '');
      set[v] = (set[v] || 0) + 1;
    }
    return set;
  }

  /* ------------------------------------------------------- skill lexicon */

  var SKILLS = [
    ['PRD', /\bprd\b|需求文档|需求说明|产品文档/i],
    ['原型', /原型|axure|墨刀|mockplus|即时设计/i],
    ['Figma', /figma|sketch|xd/i],
    ['用户调研', /用户调研|用户访谈|访谈|问卷|user research/i],
    ['数据分析', /数据分析|数据分析师|数据分 析|数分/i],
    ['埋点', /埋点|事件上报|数据采集|数据打点/i],
    ['SQL', /\bsql\b|hivesql|mysql 查询/i],
    ['Python', /\bpython\b|pandas|numpy/i],
    ['Excel', /\bexcel\b|透视表|vlookup/i],
    ['BI 看板', /\bbi\b|tableau|quickbi|powerbi|数据看板|看板搭建|帆软|superset/i],
    ['竞品分析', /竞品|行业分析|市场分析/i],
    ['AB 测试', /\bab\s?test|a\/b|ab测试|对比实验/i],
    ['指标体系', /指标体系|北极星指标|核心指标|数据指标/i],
    ['用户增长', /用户增长|拉新|留存|转化率|增长策略/i],
    ['活动运营', /活动运营|活动策划|社群|私域|裂变/i],
    ['内容运营', /内容运营|选题|文案|公众号|小红书|抖音|视频号|笔记/i],
    ['投放', /投放|信息流|竞价|广告|roi|cpa|cpc/i],
    ['电商运营', /电商|店铺|选品|上下架|客单|gmv|抖店|天猫|淘宝/i],
    ['大模型', /大模型|llm|gpt|claude|通义|文心|豆包|deepseek|agent|智能体|rag/i],
    ['提示词', /提示词|prompt|prompt engineering/i],
    ['Vibe Coding', /vibe coding|cursor|claude code|copilot|trae|codex/i],
    ['算法', /算法|机器学习|深度学习|推荐系统|nlp|cv|pytorch|tensorflow/i],
    ['Java', /\bjava\b|spring|springboot/i],
    ['Go', /\bgolang\b|\bgo\b 语言|go 语言/i],
    ['前端', /前端|react|vue|javascript|typescript|html|css/i],
    ['后端', /后端|服务端|api 设计|微服务/i],
    ['测试', /测试|用例|bug|缺陷|postman|selenium|jemeter|jmeter/i],
    ['运维/云', /运维|docker|kubernetes|k8s|linux|ci\/cd/i],
    ['游戏策划', /游戏策划|关卡|数值|玩法|剧情|文案策划/i],
    ['视觉设计', /视觉|ui|ux|交互设计|平面|海报|剪辑|后期|ae\b|premiere/i],
    ['项目管理', /项目管理|需求评审|排期|跨部门|推进|落地|协作/i],
    ['英语', /英语|cet-?6|cet-?4|雅思|托福|toefl|ielts/i]
  ];

  function detectSkills(text) {
    var t = fold(String(text || ''));
    var hits = [];
    for (var i = 0; i < SKILLS.length; i++) {
      var m = t.match(SKILLS[i][1]);
      if (m) hits.push({ id: SKILLS[i][0], raw: m[0] });
    }
    return hits;
  }

  /* --------------------------------------------------------- role family */

  var FAMILIES = [
    ['产品', /产品经理|产品实习|产品助理|产品经理实习|产品运营实习生|产品设计/],
    ['运营', /运营|内容|新媒体|社群|私域|投放|增长/],
    ['数据', /数据分析|数据产品|数据运营|数仓|bi\b/],
    ['算法/AI', /算法|机器学习|大模型|ai ?实习|nlp|cv\b|智能体/],
    ['开发', /开发|研发|前端|后端|工程师|golang|java|python 工程/],
    ['测试', /测试|质量保障|qa\b/],
    ['设计', /设计|视觉|ui\b|ux\b|交互/],
    ['策划', /策划|关卡|数值/],
    ['市场/商务', /市场|商务|营销|品牌|媒介/],
    ['人力/招聘', /招聘|hr\b|人力|猎头/]
  ];

  function familyOf(title, jd) {
    var t = String(title || '');
    for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][1].test(t)) return FAMILIES[i][0];
    var body = String(jd || '').slice(0, 600);
    for (var j = 0; j < FAMILIES.length; j++) if (FAMILIES[j][1].test(body)) return FAMILIES[j][0];
    return '其他';
  }

  /* -------------------------------------------------------------- resume */

  var SECTION_PAT = [
    ['education', /^(教育背景|教育经历|学历|教育)/],
    ['experience', /^(实习经历|工作经历|实习经验|工作经验|实践经历|项目经历|校园经历|经历)/],
    ['project', /^(项目|项目经验|科研|竞赛)/],
    ['skills', /^(专业技能|技能|技能证书|证书|语言|掌握技能)/],
    ['awards', /^(荣誉|获奖|奖项|奖学金)/],
    ['self', /^(自我评价|个人总结|自我描述|个人优势|求职意向|个人简介)/]
  ];

  function sectionOfLine(line) {
    for (var i = 0; i < SECTION_PAT.length; i++) {
      if (SECTION_PAT[i][1].test(line) && line.length <= 14) return SECTION_PAT[i][0];
    }
    return null;
  }

  /* Majors are usually written bare ("信息管理与信息系统") or with 专业 appended.
     Prefer the token that sits right after the school name on the education line. */
  function pickMajor(text) {
    var t = String(text || '').replace(/\s+/g, ' ');
    var m = t.match(/(?:大学|学院|学校)\s*([一-鿿]{2,16}?)\s*(?:专业|本科|硕士|博士|学士|专科|在读|\d{4}|$)/);
    if (m && m[1] && m[1].length >= 2) return m[1];
    var m2 = t.match(/([一-鿿]{2,16})\s*专业/);
    if (m2) return m2[1].replace(/^(主修|就读|所学|专业为)/, '');
    return '';
  }

  function isBullet(line) {
    return /^[•·∙◦▪●○\-–—*＊]/.test(line) || /^\d{1,2}[.、)）]/.test(line) || /^[（(]\d{1,2}[)）]/.test(line);
  }

  function cleanBullet(line) {
    return line.replace(/^[•·∙◦▪●○\-–—*＊]\s*/, '').replace(/^\d{1,2}[.、)）]\s*/, '').replace(/^[（(]\d{1,2}[)）]\s*/, '').trim();
  }

  function parseResume(rawText) {
    var text = normalize(rawText);
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var p = {
      raw: text,
      lines: lines,
      name: '',
      school: '',
      major: '',
      degree: '',
      gradYear: 0,
      city: '',
      weeklyDays: 0,
      months: 0,
      phone: '',
      email: '',
      skills: [],
      bullets: [],
      sections: {},
      evidence: []
    };

    var eduBlock = [], expBlock = [], skillLines = [], selfLines = [];
    var cur = 'other';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var sec = sectionOfLine(line);
      if (sec) { cur = sec; continue; }
      if (isBullet(line) || /^[•·]/.test(line)) {
        var b = { text: punct(cleanBullet(line)), section: cur };
        if (b.text.length > 6) p.bullets.push(b);
        if (cur === 'experience' || cur === 'project') expBlock.push(b.text);
        continue;
      }
      if (cur === 'education') eduBlock.push(line);
      if (cur === 'experience' || cur === 'project') expBlock.push(line);
      if (cur === 'skills') skillLines.push(line);
      if (cur === 'self') selfLines.push(line);
    }

    // Name: usually the first short line without digits, contact info or a
    // section heading. PDFs with subset fonts sometimes drop it entirely —
    // leave it blank rather than guessing a heading as a person's name.
    for (var n = 0; n < Math.min(5, lines.length); n++) {
      var cand = lines[n];
      if (sectionOfLine(cand)) continue;
      if (/简历|求职|应聘|电话|邮箱|@|意向|\d/.test(cand)) continue;
      if (/^[一-鿿]{2,4}$/.test(cand) || /^[一-鿿]{2,4}\s*[·.]\s*[一-鿿]{0,6}$/.test(cand)) {
        p.name = cand.replace(/\s+/g, ''); break;
      }
      if (/^[一-鿿]{2,4}\s+[一-鿿]{4,}$/.test(cand) && !/大学|学院/.test(cand)) {
        p.name = cand.split(/\s+/)[0]; break;
      }
    }

    var all = text;
    var eduText = eduBlock.join(' ');
    var schoolM = eduText.match(/([一-鿿]{2,12}(?:大学|学院|学校|书院))/);
    if (!schoolM) schoolM = all.match(/([一-鿿]{2,12}(?:大学|学院))/);
    if (schoolM) p.school = schoolM[1];
    p.major = pickMajor(eduText) || pickMajor(lines.slice(0, 12).join(' ')) || '';
    if (/博士/.test(all)) p.degree = '博士';
    else if (/硕士|研究生|master|mba/i.test(all)) p.degree = '硕士';
    else if (/本科|学士|bachelor/i.test(all)) p.degree = '本科';
    else if (/大专|专科|高职/.test(all)) p.degree = '大专';

    var gy = all.match(/(20\d{2})\s*届/);
    if (gy) p.gradYear = parseInt(gy[1], 10);
    if (!p.gradYear) {
      var gm = all.match(/(20\d{2})\s*[年.\-/]\s*(0?[1-9]|1[0-2])?\s*[月]?\s*毕业/);
      if (gm) p.gradYear = parseInt(gm[1], 10);
    }
    if (!p.gradYear) {
      var g2 = all.match(/毕业(?:时间|年份)?[:：]?\s*(20\d{2})/);
      if (g2) p.gradYear = parseInt(g2[1], 10);
    }

    if (/杭州/.test(all)) p.city = '杭州';
    else if (/上海/.test(all)) p.city = '上海';
    else if (/北京/.test(all)) p.city = '北京';
    else if (/深圳/.test(all)) p.city = '深圳';

    var wd = all.match(/(?:每周|一周|周)[^0-9]{0,6}([1-7])\s*(?:天|日)/);
    if (wd) p.weeklyDays = parseInt(wd[1], 10);
    var mo = all.match(/(?:实习|可实习|连续)[^0-9]{0,6}(\d{1,2})\s*个?月/);
    if (mo) p.months = parseInt(mo[1], 10);
    if (!p.months) {
      var mo2 = all.match(/(\d{1,2})\s*个月(?:以上|起)?/);
      if (mo2) p.months = parseInt(mo2[1], 10);
    }

    p.phone = (all.match(/1[3-9]\d{9}/) || [''])[0];
    p.email = (all.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];

    // Skills come from the whole resume, not just the skills section: a skill
    // proven by a bullet is worth more than one listed in a skills row.
    var listed = detectSkills(skillLines.join(' '));
    var used = detectSkills(expBlock.join(' '));
    var allHits = detectSkills(all);
    var seen = Object.create(null);
    allHits.forEach(function (s) {
      var weight = 1;
      if (used.some(function (u) { return u.id === s.id; })) weight = 2;
      if (listed.some(function (l) { return l.id === s.id; })) weight = Math.max(weight, 1);
      if (seen[s.id]) return;
      seen[s.id] = 1;
      p.skills.push({ id: s.id, weight: weight });
    });
    p.skills.sort(function (a, b) { return b.weight - a.weight; });

    p.sections.edu = eduBlock;
    p.sections.exp = expBlock;
    p.sections.skills = skillLines;
    p.sections.self = selfLines;

    // Evidence = every candidate sentence a recruiter could quote back.
    p.bullets.forEach(function (b) {
      p.evidence.push({ text: b.text, section: b.section, nums: Object.keys(numbersIn(b.text)) });
    });
    expBlock.forEach(function (t) {
      var txt = punct(t);
      if (txt.length < 8) return;
      if (!p.evidence.some(function (e) { return e.text === txt; })) {
        p.evidence.push({ text: txt, section: 'experience', nums: Object.keys(numbersIn(txt)) });
      }
    });

    return p;
  }

  /* ------------------------------------------------------------------ JD */

  function splitJd(jd) {
    var t = normalize(jd);
    var reqStart = t.search(/(任职要求|职位要求|岗位要求|职位需求|要求如下|任职资格|你需要)/);
    var dutyText = reqStart > 0 ? t.slice(0, reqStart) : t;
    var reqText = reqStart > 0 ? t.slice(reqStart) : '';
    return {
      duty: items(dutyText),
      must: items(reqText),
      full: t
    };
  }

  var HEAD_RE = /^(岗位职责|工作职责|职位描述|工作内容|任职要求|职位要求|岗位要求|任职资格|我们希望你|你需要|加分项|其他要求|福利待遇|实习收获)[:：]?\s*$/;
  var HEAD_ALT = '岗位职责|工作职责|职位描述|工作内容|任职要求|职位要求|岗位要求|任职资格|加分项|我们希望你|你需要';

  /* Boss 直聘 JDs arrive either one-item-per-line or as one long paragraph with
     " 1. " in the middle. Break both forms before enumerating. */
  function segment(block) {
    var s = String(block || '').replace(/\s+/g, ' ').trim();
    s = s.replace(new RegExp('\\s*(' + HEAD_ALT + ')[:：]\\s*', 'g'), '\n$1\n');
    s = s.replace(/\s(?=\d{1,2}\s*[.、)）]\s*[^\d\s])/g, '\n');
    s = s.replace(/\s(?=[一二三四五六七八九十]{1,2}[、.]\s*[^\d])/g, '\n');
    s = s.replace(/\s(?=[•·∙◦▪●○])\s*/g, '\n');
    return s.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function items(block) {
    var out = [];
    var buf = '';
    var lines = segment(block);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (HEAD_RE.test(line)) { if (buf) { out.push(buf); buf = ''; } continue; }
      var starts = /^(\d{1,2}[.、)）]|[（(]\d{1,2}[)）]|[•·∙]|[一二三四五六七八九十]{1,2}[、.])/.test(line);
      if (starts && buf) { out.push(buf); buf = line; }
      else buf = buf ? buf + (line.length > 1 ? line : '') : line;
    }
    if (buf) out.push(buf);
    return out.map(function (s) {
      return s
        .replace(/^(\d{1,2}[.、)）]|[（(]\d{1,2}[)）]|[•·∙]|[一二三四五六七八九十]{1,2}[、.])\s*/, '')
        .replace(new RegExp('^(' + HEAD_ALT + ')[:：]\\s*'), '')
        .trim();
    }).filter(function (s) { return s.length >= 6; });
  }

  /* --------------------------------------------------------- job index */

  function buildIndex(jobs) {
    var df = Object.create(null);
    var N = jobs.length || 1;
    var jdCache = Object.create(null);
    jobs.forEach(function (job, idx) {
      var parsed = splitJd(job.jd);
      var tk = tokens(parsed.duty.concat(parsed.must).join(' '));
      jdCache[idx] = { parsed: parsed, tokens: tk, tset: toSet(tk) };
      tk.forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    var idf = Object.create(null);
    for (var k in df) idf[k] = Math.log((N + 1) / (df[k] + 0.5));
    return { idf: idf, cache: jdCache, N: N };
  }

  function toSet(arr) { var s = Object.create(null); arr.forEach(function (x) { s[x] = 1; }); return s; }

  function weightSum(tk, idf, cap) {
    var s = 0;
    for (var i = 0; i < tk.length; i++) s += Math.min(idf[tk[i]] || 1.2, cap || 6);
    return s;
  }

  /* Overlap of two token sets, IDF weighted and length-normalised. */
  function similarity(aSet, aW, bSet, idf) {
    var inter = 0, j = 0;
    for (var k in aSet) {
      if (bSet[k]) { inter += Math.min(idf[k] || 1.2, 6); j++; }
    }
    if (!j) return { score: 0, hits: [] };
    var norm = Math.sqrt(aW || 1);
    return { score: inter / norm, hits: Object.keys(aSet).filter(function (k) { return bSet[k]; }) };
  }

  /* ------------------------------------------------------------- scoring */

  var DEGREE_RANK = { '大专': 1, '本科': 2, '硕士': 3, '博士': 4 };

  function jobGates(job, profile) {
    var jd = job.jd || '';
    var g = [];
    var gy = jd.match(/(2[0-9])\s*届(?:及以后|及以上|及|以后)?/);
    if (gy) {
      var want = 2000 + parseInt(gy[1], 10);
      var laterOk = /及以后|及以上|以后/.test(gy[0]);
      if (profile.gradYear) {
        if (want !== profile.gradYear && !(laterOk && profile.gradYear > want)) {
          g.push({ kind: 'gradYear', level: 'hard', text: '限定 ' + (2000 + parseInt(gy[1], 10)) + ' 届' + (laterOk ? '及以后' : '') + '，简历是 ' + profile.gradYear + ' 届' });
        }
      } else {
        g.push({ kind: 'gradYear', level: 'unknown', text: 'JD 限定 ' + (2000 + parseInt(gy[1], 10)) + ' 届，简历里没写毕业时间' });
      }
    }
    var needDeg = job.edu.indexOf('硕士') >= 0 ? '硕士' : job.edu.indexOf('本科') >= 0 ? '本科' : job.edu.indexOf('大专') >= 0 ? '大专' : '';
    if (needDeg && profile.degree && DEGREE_RANK[profile.degree] < DEGREE_RANK[needDeg]) {
      g.push({ kind: 'degree', level: 'hard', text: '要求 ' + needDeg + '，简历是 ' + profile.degree });
    }
    var needDays = (job.sched.match(/([1-7])\s*天\/周/) || [])[1];
    if (needDays && profile.weeklyDays && parseInt(needDays, 10) > profile.weeklyDays) {
      g.push({ kind: 'days', level: 'soft', text: '要求每周 ' + needDays + ' 天，简历写每周 ' + profile.weeklyDays + ' 天' });
    }
    var needMonths = (job.sched.match(/时长\s*(\d{1,2})\s*个月/) || [])[1];
    if (needMonths && profile.months && parseInt(needMonths, 10) > profile.months) {
      g.push({ kind: 'months', level: 'soft', text: '要求连续 ' + needMonths + ' 个月，简历写 ' + profile.months + ' 个月' });
    }
    if (/无转正|不提供转正|没有转正/.test(jd)) g.push({ kind: 'convert', level: 'info', text: '明确写了无转正机会' });
    if (profile.city && job.loc && job.loc.indexOf('杭州') >= 0 && profile.city !== '杭州') {
      g.push({ kind: 'city', level: 'soft', text: '岗位在杭州，简历城市是 ' + profile.city });
    }
    return g;
  }

  function scoreJob(job, profile, index, idx) {
    var entry = index.cache[idx];
    var parsed = entry.parsed;
    var gates = jobGates(job, profile);
    var hardFail = gates.some(function (g) { return g.level === 'hard'; });

    var jobTokens = entry.tokens;
    var jobSet = entry.tset;
    var jobW = weightSum(jobTokens, index.idf, 6);
    var resumeTokens = profile._tokens || (profile._tokens = tokens(profile.raw));
    var resumeSet = profile._tset || (profile._tset = toSet(resumeTokens));
    var sim = similarity(resumeSet, weightSum(resumeTokens, index.idf, 6), jobSet, index.idf);

    // Skill overlap is the strongest single signal for intern roles.
    var jobSkills = detectSkills(job.jd);
    var resumeSkillIds = profile.skills.map(function (s) { return s.id; });
    var skillHits = jobSkills.filter(function (s) { return resumeSkillIds.indexOf(s.id) >= 0; });
    var skillCover = jobSkills.length ? skillHits.length / jobSkills.length : 0;

    var fam = familyOf(job.t, job.jd);
    var resumeFam = profile._family || (profile._family = guessResumeFamily(profile));
    var famHit = fam === resumeFam ? 1 : (adjacent(fam, resumeFam) ? 0.45 : 0);

    var keyword = Math.min(1, sim.score / 12);
    var raw = 0.34 * keyword + 0.36 * Math.max(skillCover, famHit * 0.62) + 0.18 * famHit + 0.12 * activityScore(job.act);

    var score = Math.round(40 + raw * 55);
    if (hardFail) score = Math.min(score, 44);
    if (gates.some(function (g) { return g.kind === 'days' || g.kind === 'months'; })) score = Math.min(score, 78);
    score = Math.max(8, Math.min(95, score));

    return {
      job: job,
      score: score,
      hardFail: hardFail,
      gates: gates,
      family: fam,
      skillHits: skillHits,
      skillCover: skillCover,
      keyword: keyword,
      sim: sim,
      parsed: parsed,
      idx: idx
    };
  }

  function adjacent(a, b) {
    var near = {
      '产品': ['运营', '数据', '设计'],
      '运营': ['产品', '市场/商务', '数据'],
      '数据': ['产品', '算法/AI', '运营'],
      '算法/AI': ['开发', '数据'],
      '开发': ['算法/AI', '测试'],
      '测试': ['开发'],
      '设计': ['产品', '运营'],
      '策划': ['运营', '设计'],
      '市场/商务': ['运营'],
      '人力/招聘': ['运营']
    };
    return (near[a] || []).indexOf(b) >= 0;
  }

  function activityScore(act) {
    if (!act) return 0.4;
    if (/刚刚|在线/.test(act)) return 1;
    if (/今日/.test(act)) return 0.8;
    if (/3日|三日/.test(act)) return 0.55;
    if (/本周/.test(act)) return 0.4;
    if (/2周|两周|月内/.test(act)) return 0.18;
    return 0.35;
  }

  function guessResumeFamily(profile) {
    var text = profile.raw;
    var counts = {};
    ['产品', '运营', '数据', '算法/AI', '开发', '测试', '设计', '策划', '市场/商务', '人力/招聘'].forEach(function (f) { counts[f] = 0; });
    var sig = {
      '产品': /prd|需求文档|原型|产品经理|产品助理|需求调研|产品设计/gi,
      '运营': /运营|新媒体|公众号|小红书|社群|活动策划|内容/gi,
      '数据': /数据分析|sql|埋点|看板|报表|指标/gi,
      '算法/AI': /算法|模型|训练|pytorch|大模型|提示词/gi,
      '开发': /开发|java|python|前端|后端|接口|git/gi,
      '测试': /测试|用例|缺陷|bug/gi,
      '设计': /视觉|交互|figma|sketch|海报|剪辑/gi,
      '策划': /策划|关卡|数值|玩法/gi,
      '市场/商务': /市场|商务|品牌|投放/gi,
      '人力/招聘': /招聘|简历筛选|面试安排|hr/gi
    };
    Object.keys(sig).forEach(function (f) {
      var m = text.match(sig[f]);
      counts[f] = m ? m.length : 0;
    });
    var best = '产品', bv = -1;
    Object.keys(counts).forEach(function (f) { if (counts[f] > bv) { bv = counts[f]; best = f; } });
    return bv === 0 ? '产品' : best;
  }

  /* Requirement ↔ evidence pairing: the actual persuasion payload.
     Greedy stock assignment — each resume line is used at most once, so three
     different requirements never all point at the same bullet. */
  function buildPairs(profile, scored, index) {
    var parsed = scored.parsed;
    var reqs = [];
    parsed.must.forEach(function (t) { reqs.push({ text: t, type: 'must' }); });
    parsed.duty.forEach(function (t) { reqs.push({ text: t, type: 'duty' }); });

    var evidence = profile.evidence.filter(function (e) { return e.text.length >= 8; });
    var cand = [];
    reqs.forEach(function (req, ri) {
      if (req.text.length < 8) return;
      var rt = tokens(req.text + ' ' + (scored.job.t || ''));
      var rSet = toSet(rt);
      var key = Object.keys(rSet).sort().join('|');
      evidence.forEach(function (ev, ei) {
        var et = ev._tk || (ev._tk = tokens(ev.text));
        var eSet = ev._tset || (ev._tset = toSet(et));
        var ew = ev._tw || (ev._tw = weightSum(et, index.idf, 6));
        var sim = similarity(eSet, ew, rSet, index.idf);
        if (sim.score <= 0) return;
        var v = sim.score * (ev.nums.length ? 1.3 : 1) * (req.type === 'must' ? 1.15 : 1);
        cand.push({ ri: ri, ei: ei, v: v, key: key, sim: sim, req: req });
      });
    });
    cand.sort(function (a, b) { return b.v - a.v; });

    var usedReq = Object.create(null), usedEv = Object.create(null);
    var pairs = [];
    for (var i = 0; i < cand.length && pairs.length < 4; i++) {
      var c = cand[i];
      if (usedEv[c.ei]) continue;
      // Two requirements almost identical in wording are the same requirement.
      if (usedReq[c.key]) continue;
      if (c.v < 1.1) break;
      usedEv[c.ei] = 1;
      usedReq[c.key] = 1;
      pairs.push({
        req: trimReq(c.req.text),
        ev: evidence[c.ei].text,
        type: c.req.type,
        strength: c.v,
        hits: c.sim.hits.slice(0, 6)
      });
    }
    pairs.sort(function (a, b) { return b.strength - a.strength; });
    return pairs;
  }

  /* Quote-ready short form of a JD clause: drop section prefixes, cut at the
     first real sentence boundary, keep the actionable head of the sentence. */
  function trimReq(t) {
    var s = punct(String(t).replace(/\s+/g, ' ').trim());
    s = s.replace(/^(岗位职责|工作职责|职位描述|任职要求|职位要求|岗位要求|任职资格)[:：]\s*/, '');
    s = s.replace(/^\d{1,2}[.、)）]\s*/, '');
    var segs = s.split(/[。；]/).filter(function (x) { return x.trim(); });
    if (segs.length > 1 && segs[0].length < 8) s = segs[0] + '，' + segs[1];
    else if (segs.length) s = segs[0];
    if (s.length > 46) {
      var comma = s.lastIndexOf('，', 42);
      s = s.slice(0, comma > 18 ? comma : 44) + '…';
    }
    return s;
  }

  function match(profile, jobs, index) {
    var scored = jobs.map(function (job, idx) { return scoreJob(job, profile, index, idx); });
    scored.forEach(function (s) { s.pairs = buildPairs(profile, s, index); });
    scored.sort(function (a, b) {
      if (a.hardFail !== b.hardFail) return a.hardFail ? 1 : -1;
      var pa = a.pairs.length ? a.pairs[0].strength : 0;
      var pb = b.pairs.length ? b.pairs[0].strength : 0;
      // Evidence carries weight but never outranks a real score gap: a job you
      // cannot argue for is not a better match than one you can.
      return (b.score + Math.min(pb, 3.5) * 1.6) - (a.score + Math.min(pa, 3.5) * 1.6);
    });
    return scored;
  }

  /* ------------------------------------------------------------ rewriting */

  var CONNECT = ['负责', '参与', '主导', '协助', '独立', '完成', '推动', '搭建', '输出', '跟进', '梳理', '设计', '落地', '维护', '支持'];

  function pickTopSkills(profile, jobSkills, n) {
    var jobIds = jobSkills.map(function (s) { return s.id; });
    var ordered = profile.skills.slice().sort(function (a, b) {
      var ai = jobIds.indexOf(a.id) >= 0 ? 1 : 0;
      var bi = jobIds.indexOf(b.id) >= 0 ? 1 : 0;
      if (ai !== bi) return bi - ai;
      return b.weight - a.weight;
    });
    return ordered.slice(0, n || 5).map(function (s) { return s.id; });
  }

  /* Rewrite = selection + ordering + a templated headline. Facts stay verbatim. */
  function rewrite(profile, scored) {
    var job = scored.job;
    var jobSkills = detectSkills(job.jd);
    var topSkills = pickTopSkills(profile, jobSkills, 5);
    var pairs = scored.pairs || [];
    var usedEv = pairs.length ? pairs.slice(0, 3) : [];

    var tag = [profile.gradYear ? profile.gradYear + ' 届' : '', profile.degree, profile.major].filter(Boolean).join(' · ');
    var expBits = [];
    profile.evidence.forEach(function (e) {
      if (e.nums.length >= 1 && e.text.length > 12) expBits.push(e);
    });
    var headlineSkills = topSkills.slice(0, 3).join(' / ');

    var headline = [tag, headlineSkills].filter(Boolean).join('｜');
    if (!headline) headline = profile.name ? profile.name + '｜' + (profile.major || '') : '';

    var summary = [];
    if (tag) summary.push(tag + (profile.school ? '，' + profile.school : '') + '。');
    if (usedEv.length) {
      var lead = usedEv.map(function (u) { return u.ev; }).slice(0, 3);
      summary.push('与该岗位直接相关的经历：' + lead.join('；') + '。');
    } else if (expBits.length) {
      summary.push('相关经历：' + expBits.slice(0, 2).map(function (e) { return e.text; }).join('；') + '。');
    }
    var avail = [];
    if (profile.weeklyDays) avail.push('每周可到岗 ' + profile.weeklyDays + ' 天');
    if (profile.months) avail.push('可连续实习 ' + profile.months + ' 个月');
    if (profile.city) avail.push('现居' + profile.city);
    if (avail.length) summary.push(avail.join('，') + '。');

    // Reorder experience bullets: JD-relevant first, quantified second.
    var jobTokens = tokens(job.jd);
    var jobSet = toSet(jobTokens);
    var ordered = profile.bullets.slice().sort(function (a, b) {
      return relScore(b, jobSet) - relScore(a, jobSet);
    });

    var changes = [];
    if (headline) {
      changes.push({
        what: '首行标签',
        detail: '改成「' + headline + '」，把岗位要的 ' + (topSkills.slice(0, 2).join('、') || '关键词') + ' 放到 HR 第一眼的位置。'
      });
    }
    if (summary.length) {
      changes.push({
        what: '新增个人概述',
        detail: '用你简历里已有的 ' + (usedEv.length || Math.min(2, expBits.length)) + ' 条事实拼成 3 句，没有加任何新事实。'
      });
    }
    if (ordered.length && profile.bullets.length && ordered[0].text !== profile.bullets[0].text) {
      changes.push({
        what: '经历排序',
        detail: '把「' + ordered[0].text.slice(0, 24) + '…」提到第一条，因为 JD 的职责第一条写的是这块。'
      });
    }
    if (topSkills.length) {
      changes.push({
        what: '技能排序',
        detail: '把 ' + topSkills.slice(0, 3).join('、') + ' 提到最前，其余保留不动。'
      });
    }
    var risky = (scored.gates || []).filter(function (g) { return g.level !== 'info'; });
    if (risky.length) {
      changes.push({
        what: '没有动的地方',
        detail: risky.map(function (g) { return g.text; }).join('；') + '。这些要你在沟通里自己说，简历不替他撒谎。'
      });
    }

    return {
      headline: headline,
      summary: summary.join(''),
      skillLine: topSkills.join('、'),
      bullets: ordered.map(function (b) { return b.text; }),
      changes: changes,
      numberCheck: checkNumbers(profile.raw, [headline, summary.join(''), topSkills.join('、')].concat(ordered.map(function (b) { return b.text; })).join(' '))
    };
  }

  function relScore(b, jobSet) {
    var tk = b._tk || (b._tk = tokens(b.text));
    var hit = 0;
    for (var i = 0; i < tk.length; i++) if (jobSet[tk[i]]) hit++;
    return hit / Math.sqrt(tk.length || 1) + (b.nums && b.nums.length ? 0.6 : 0);
  }

  /* Every number in the rewritten resume must exist in the original. */
  function checkNumbers(original, rewritten) {
    var a = numbersIn(original), b = numbersIn(rewritten);
    var added = [], kept = [];
    Object.keys(b).forEach(function (n) {
      if (a[n]) kept.push(n); else added.push(n);
    });
    return { added: added, kept: kept, ok: added.length === 0 };
  }

  /* ------------------------------------------------------ WeChat message */

  /* The delivered text has one job: make the operator's job (paste, argue,
     close) easy on a single phone screen. Three quotes from the JD paired with
     three lines from the resume, then the two facts that decide the reply. */
  function buildMessage(profile, scored, rw) {
    var job = scored.job;
    var pairs = (scored.pairs || []).slice(0, 3);
    var out = [];

    out.push('今天这 1 个：' + job.c + ' · ' + job.t);
    var meta = [job.pay !== '平台未提供' ? job.pay : '', shortSched(job.sched), job.act].filter(Boolean).join(' · ');
    if (meta) out.push(meta);
    out.push('');

    out.push('为什么是它' + (pairs.length ? '（' + pairs.length + ' 处对得上）' : ''));
    pairs.forEach(function (p, i) {
      out.push((i + 1) + '「' + short(p.req, 30) + '」');
      out.push('  → 你「' + short(p.ev, 40) + '」');
    });

    var fit = fitLine(profile, job);
    if (fit) out.push('· ' + fit);

    var risk = (scored.gates || []).filter(function (g) { return g.level === 'hard' || g.level === 'soft'; })[0];
    if (risk) out.push('· 要对好的一点：' + risk.text + '。');

    out.push('');
    out.push('回「跟」我把简历按这个岗排好发你，改动只有顺序和开头一段，公司、时间、数字都不动。');
    return out.join('\n');
  }

  function shortSched(s) {
    var t = String(s || '');
    var days = (t.match(/([1-7])\s*天\/周/) || [])[1];
    var months = (t.match(/时长\s*(\d{1,2})\s*个月/) || [])[1];
    if (days && months) return '每周 ' + days + ' 天 · ' + months + ' 个月';
    if (days) return '每周 ' + days + ' 天';
    return '';
  }

  /* Say the availability match out loud: it is the cheapest, most concrete
     proof that this posting fits this person's calendar, not just their skills. */
  function fitLine(profile, job) {
    var needDays = (String(job.sched).match(/([1-7])\s*天\/周/) || [])[1];
    var needMonths = (String(job.sched).match(/时长\s*(\d{1,2})\s*个月/) || [])[1];
    var bits = [];
    if (needDays && profile.weeklyDays && profile.weeklyDays >= parseInt(needDays, 10)) {
      bits.push('岗要 ' + needDays + ' 天/周，你写的是 ' + profile.weeklyDays + ' 天');
    }
    if (needMonths && profile.months && profile.months >= parseInt(needMonths, 10)) {
      bits.push('要连续 ' + needMonths + ' 个月，你写的是 ' + profile.months + ' 个月');
    }
    if (!bits.length) return '';
    return bits.join('；') + '，时间这关直接过。';
  }

  function short(s, n) {
    var t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  global.JOEngine = {
    normalize: normalize, tighten: tighten, tokens: tokens, numbersIn: numbersIn,
    detectSkills: detectSkills, familyOf: familyOf, parseResume: parseResume,
    splitJd: splitJd, buildIndex: buildIndex, match: match, rewrite: rewrite,
    buildMessage: buildMessage, checkNumbers: checkNumbers,
    guessResumeFamily: guessResumeFamily, trimReq: trimReq
  };
})(typeof window !== 'undefined' ? window : globalThis);
