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
  var PUNCT_MAP = { ',': '，', ':': '：', ';': '；', '?': '？', '!': '！', '(': '（', ')': '）' };
  var PUNCT_ANY = /[,:;?!()]/;
  var PUNCT_ALL = /([,:;?!()])/g;
  function punct(s) {
    var t = String(s == null ? '' : s);
    // Most of the text has no ASCII punctuation left after NFKC, and this runs
    // over whole JD bullets many times per match. Scanning beats rebuilding.
    if (!PUNCT_ANY.test(t)) return t;
    return t.replace(PUNCT_ALL, function (ch, c, off) {
      var prev = off > 0 ? t[off - 1] : '';
      var next = off + 1 < t.length ? t[off + 1] : '';
      return CJK.test(prev) || CJK.test(next) ? PUNCT_MAP[c] : c;
    });
  }

  /* Bigrams that any two resumes and any two JDs will share, because they are
     filler verbs and generic nouns. Overlap made only of these is not evidence
     that the same work was done — "能独立完成交互原型设计" and "SQL 独立完成订单
     与品类分析" share 独立/立完/完成 and nothing else. */
  var GENERIC_WORDS = '完成 独立 负责 参与 协助 支持 配合 进行 跟进 使用 熟练 掌握 具备 能力 良好 相关 工作 内容 要求 优先 项目 经验 熟悉 了解 能够 可以 以及 需要 提供 主导 搭建 落地 推进 优化 提升 管理 沟通 团队 时间 一定 我们 你们 这个 那个 公司 用户 产品 实习 助理 岗位 职责 任职 描述 数据 分析 完成 独立完成 独立 一定 一起 相关 有关 各类 各种 其他 及其 并且 同时 根据 按照 通过 针对 对于 关于 由于 因此 所以 但是 而且 目前 现在 通常 一般 主要 部分 方面 情况 方式 方法 问题 计划 安排 建议 意见 处理 提交 整理 记录 统计 协助完成 投入 从事 担任 所学 按照';
  var GENERIC_BG = (function () {
    var set = Object.create(null);
    GENERIC_WORDS.split(/\s+/).forEach(function (w) {
      if (w.length === 1) { set[w] = 1; return; }
      for (var i = 0; i < w.length - 1; i++) set[w.slice(i, i + 2)] = 1;
    });
    return set;
  })();

  /* Bigrams over CJK runs plus lowercase latin/digit words. Cheap and good
     enough for Chinese keyword overlap without a segmentation dictionary. */
  function tokens(text) {
    var t = tighten(String(text || '')).toLowerCase();
    var out = Object.create(null);
    var latin = t.match(/[a-z][a-z0-9+#.\/-]{1,20}/g);
    if (latin) for (var i = 0; i < latin.length; i++) out[latin[i]] = 1;
    var runs = t.match(/[一-鿿]+/g);
    if (runs) for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      for (var k = 0; k < run.length - 1; k++) {
        var a = run[k], b = run[k + 1];
        if (STOP_CHARS.indexOf(a) >= 0 && STOP_CHARS.indexOf(b) >= 0) continue;
        out[run.slice(k, k + 2)] = 1;
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

  /* A line that names where and when someone worked, but not what they did:
     "公司 · 岗位 2025.07–2025.09". Usable as context, useless as proof. */
  function isHeaderLine(text) {
    var t = String(text || '');
    if (t.length > 60) return false;
    var hasRange = /20\d{2}\s*[.\-/年]\s*\d{1,2}\s*[-–—~至]\s*20\d{2}\s*[.\-/年]?\s*\d{0,2}/.test(t)
      || /20\d{2}\s*[-–—~至]\s*20\d{2}/.test(t)
      || /\d{4}\s*[.\-/]\s*\d{1,2}\s*[-–—~至]\s*(至今|现在|今)/.test(t);
    if (!hasRange) return false;
    // A dated line is still real evidence if it states an outcome. Strip job
    // titles first, so "项目负责人" is not read as the verb "负责".
    var head = t.split(/20\d{2}/)[0].replace(/负责人|负责人[：:]?|主导人/g, '');
    if (/[\d.]+\s*(?:%|％|倍)/.test(t)) return false;
    if (/(?:提升|增长|提高|增加|降低|下降|节省|缩短|达成|完成|负责|主导|搭建|落地|输出|设计)/.test(head)) return false;
    return true;
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
    // Section headers ("公司 · 岗位 2025.07–2025.09") are deliberately excluded:
    // they carry a company and a date but no achievement, so quoting one back
    // says nothing about what this person can do.
    p.bullets.forEach(function (b) {
      if (isHeaderLine(b.text)) return;
      p.evidence.push({ text: b.text, section: b.section, nums: Object.keys(numbersIn(b.text)) });
    });
    expBlock.forEach(function (t) {
      var txt = punct(t);
      if (txt.length < 8) return;
      if (isHeaderLine(txt)) return;
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

  var HEAD_RE = /^(岗位职责|工作职责|职位描述|工作内容|任职要求|职位要求|岗位要求|任职资格|我们希望你|你需要|加分项|其他要求|福利待遇|实习收获)[:：]?$/;
  var HEAD_ALT = '岗位职责|工作职责|职位描述|工作内容|任职要求|职位要求|岗位要求|任职资格|加分项|我们希望你|你需要';

  /* The form a header line takes after extraction: spaces removed, and any
     short parenthetical qualifier dropped — "岗位要求（硬性）" is still a
     section title, not a duty worth quoting. */
  function headerKey(line) {
    return punct(String(line)).replace(/[\s ]+/g, '')
      .replace(/[（(][^）)]{0,8}[）)]$/, '');
  }

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
      /* Test the header on a whitespace-free copy. PDF and xlsx extraction
         routinely breaks a header in the middle ("职位描 述：", "岗位 职 责:"),
         and those then survived as quotable duties — the message could have
         offered a section title as evidence of fit. */
      if (HEAD_RE.test(headerKey(line))) { if (buf) { out.push(buf); buf = ''; } continue; }
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
      // Skills and family read the posting only, so they are resolved once
      // here instead of for every resume that gets matched against the pool.
      jdCache[idx] = {
        parsed: parsed, tokens: tk, tset: toSet(tk),
        skills: detectSkills(job.jd), fam: familyOf(job.t, job.jd)
      };
      tk.forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    var idf = Object.create(null);
    for (var k in df) idf[k] = Math.log((N + 1) / (df[k] + 0.5));
    for (var j = 0; j < jobs.length; j++) {
      jdCache[j].w = weightSum(jdCache[j].tokens, idf, 6);
    }
    return { idf: idf, cache: jdCache, N: N };
  }

  function toSet(arr) { var s = Object.create(null); arr.forEach(function (x) { s[x] = 1; }); return s; }

  function weightSum(tk, idf, cap) {
    var s = 0;
    for (var i = 0; i < tk.length; i++) s += Math.min(idf[tk[i]] || 1.2, cap || 6);
    return s;
  }

  /* Overlap of two token sets, IDF weighted and length-normalised. Walks the
     key list rather than enumerating the set: `for in` on a null-prototype map
     is several times slower, and this runs once per posting. */
  function similarity(aKeys, aSet, aW, bSet, idf) {
    var inter = 0, j = 0;
    for (var i = 0; i < aKeys.length; i++) {
      var k = aKeys[i];
      if (bSet[k]) { inter += Math.min(idf[k] || 1.2, 6); j++; }
    }
    if (!j) return { score: 0, n: 0 };
    return { score: inter / Math.sqrt(aW || 1), n: j };
  }

  /* Symmetric version, used for pairing only so the posted score keeps its
     calibration. Normalising by the evidence alone punished the tightest
     matches: "输出需求文档" against "输出需求文档与原型 14 个页面" shares
     everything the requirement asks for, but a short requirement can only
     produce a small numerator, so it scored below a long vague overlap. */
  /* Walks the shorter side's key list rather than `for in`, which is several
     times slower on a null-prototype map of this size, and this runs for every
     requirement against every evidence line of every posting. */
  function cosine(aKeys, aSet, aW, bKeys, bSet, bW, idf) {
    var ka = aKeys, kb = bSet, small = aKeys, sw = aW, lw = bW;
    if (aKeys.length > bKeys.length) { small = bKeys; kb = aSet; sw = bW; lw = aW; }
    var inter = 0, j = 0;
    for (var i = 0; i < small.length; i++) {
      var k = small[i];
      if (kb[k]) { inter += Math.min(idf[k] || 1.2, 6); j++; }
    }
    if (!j) return { score: 0, n: 0 };
    // The shared words are collected separately, by the handful of pairs that
    // survive the assignment. Building the list for all ~44,000 candidate pairs
    // and throwing nearly all of them away was the single largest cost in here.
    return { score: inter / Math.sqrt((sw || 1) * (lw || 1)), n: j };
  }

  function sharedWords(aKeys, aSet, limit) {
    var out = [];
    for (var i = 0; i < aKeys.length; i++) {
      if (aSet[aKeys[i]]) { out.push(aKeys[i]); if (out.length >= limit) break; }
    }
    return out;
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

    var jobSet = entry.tset;
    var resumeTokens = profile._tokens || (profile._tokens = tokens(profile.raw));
    var resumeSet = profile._tset || (profile._tset = toSet(resumeTokens));
    var resumeW = profile._w || (profile._w = weightSum(resumeTokens, index.idf, 6));
    var sim = similarity(resumeTokens, resumeSet, resumeW, jobSet, index.idf);

    // Skill overlap is the strongest single signal for intern roles.
    var jobSkills = entry.skills;
    var resumeSkillIds = profile.skills.map(function (s) { return s.id; });
    var skillHits = jobSkills.filter(function (s) { return resumeSkillIds.indexOf(s.id) >= 0; });
    var skillCover = jobSkills.length ? skillHits.length / jobSkills.length : 0;

    var fam = entry.fam;
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

  /* A result the candidate can point at: a number moving to another number, or
     a bare percentage change. "活跃用户从 1200 提升到 3100" is the hardest
     thing an intern resume can say, and bigram overlap scores it near zero
     against a JD that says "用户增长" — so it needs to be recognised. */
  var OUTCOME_RES = [
    /从\s*[\d.,]+\s*[^，。；]{0,12}?(?:提升|增长|提高|增加|上涨|升至|升到|降低|下降)\s*(?:到|至|→)?\s*[\d.,]+/,
    /(?:提升|增长|提高|增加|降低|下降|节省|缩短)[^\d，。；]{0,6}[\d.]+\s*(?:%|％|倍)/,
    /[\d.]+\s*(?:%|％)\s*(?:到|至|→|->)\s*[\d.]+\s*(?:%|％)/
  ];
  function outcomeIn(text) {
    var t = String(text || '');
    for (var i = 0; i < OUTCOME_RES.length; i++) if (OUTCOME_RES[i].test(t)) return true;
    return false;
  }
  /* The outcome a JD is asking for, named with the JD's own word. Ordered so
     the fuller term wins: 用户增长 before 增长. */
  var RESULT_CONCEPTS = ['用户增长', '付费转化', '转化率', '留存率', '复购率', '复购', '拉新', '留存', '转化', '活跃度', '活跃', '流失', '客单价', 'GMV'];
  /* Metrics that answer different questions. A JD asking for 付费转化 is not
     answered by a resume saying 活跃用户 grew: that is a different number
     moving, and pretending otherwise is the exact overreach this tool avoids. */
  var RESULT_FAMILY = {
    '用户增长': 'growth', '拉新': 'growth', '活跃': 'growth', '活跃度': 'growth', '留存': 'growth', '留存率': 'growth',
    '流失': 'growth', '复购': 'growth', '复购率': 'growth',
    '付费转化': 'money', '转化': 'money', '转化率': 'money', '客单价': 'money', 'GMV': 'money'
  };
  function resultConcepts(text) {
    var t = String(text || ''), out = [];
    for (var i = 0; i < RESULT_CONCEPTS.length; i++) if (t.indexOf(RESULT_CONCEPTS[i]) >= 0) out.push(RESULT_CONCEPTS[i]);
    // Drop a shorter concept already covered by a longer one (活跃 inside 活跃度).
    return out.filter(function (c) { return !out.some(function (d) { return d !== c && d.indexOf(c) >= 0; }); });
  }

  /* The clause of a resume line that carries the change, on its own. Quoting
     the whole line buries the numbers behind the setup clause. */
  function resultClause(s) {
    var t = punct(String(s || '').replace(/\s+/g, ' ').trim());
    var parts = t.split(/[，、；]/);
    for (var i = 0; i < parts.length; i++) {
      if (outcomeIn(parts[i])) return parts[i].replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
    }
    return t;
  }

  /* Degree, major and graduation-year requirements are gates, not duties. They
     are already enforced by the hard-fail check, so pairing them against a
     resume line proves nothing and lets "本科及以上学历在读" argue a match. */
  function isEligibility(text) {
    var t = String(text || '');
    return /本科|专科|大专|硕士|博士|研究生|学历|学位|在读|应届|届别|\d{4}\s*届|专业不限|专业要求|统招|全日制/.test(t);
  }

  /* Below this strength a pairing is a coincidence of vocabulary rather than a
     shared piece of work. Measured across the pool: at 1.1 every third posting
     claims a match; the pair that starts an argument ("结合埋点与用户反馈定位
     流失环节" ↔ "帮助运营定位注册流失环节") scores 3.47, while accidental
     overlap sits near 1.2. 1.35 keeps visibly real matches and drops the rest. */
  var PAIR_MIN = 0.14;

  /* Strength at which a pairing is strong enough to carry an argument on its
     own, as opposed to merely being defensible. Used for ordering: three weak
     overlaps should not outrank one requirement answered squarely. */
  var PAIR_STRONG = 0.24;

  /* Duties whose wording is not work: pay, benefits, hours, address, how to
     apply. Naming one of these as "the thing this posting wants" would be
     quotable and empty. */
  var GAP_SKIP = /福利|五险一金|双休|工作时间|上班时间|薪资|薪酬|待遇|地点|地址|面试|投递|邮箱|联系方式|欢迎|团建|补贴|包吃|包住|转正|入职|法定节假日|年假|弹性|公司介绍|职位描述|岗位职责/;
  /* Some postings introduce their duties with a rhetorical question the
     candidate is meant to answer ("你将围绕「哪些渠道带来了高价值用户」
     ……"). It is the framing of the job, not a task, and quoting it as the
     thing the resume fails to answer would be quoting air. */
  var GAP_LEADIN = /^你将|等问题|？|「|」/;

  /* How much of a duty the gap line may quote. Long enough to name the work,
     short enough that the line still reads as one sentence on a phone: 87% of
     qualifying clauses are ≤26 characters, so the cap bites on the tail only. */
  var GAP_QUOTE = 30;

  /* A JD duty is usually a list of four or five tasks in one sentence. Comparing
     it whole against a resume bullet dilutes every match: "用户增长。跟踪注册、
     首次体验、留存和分享数据，结合埋点与用户反馈定位流失环节。参与新手引导…"
     shares enough to score well but no single clause gets credit for being
     answered. Splitting first lets "结合埋点与用户反馈定位流失环节" pair with
     the resume line that answers exactly that, and leaves the untouched clauses
     visible as gaps. */
  function dutyClauses(text) {
    var t = punct(String(text || '').replace(/\s+/g, ' ').trim())
      .replace(/^[-–—·•\s]+/, '')
      .replace(/^[0-9]{1,2}[.、)）]\s*/, '');
    return t.split(/[，。；]/).map(function (s) {
      return s.replace(/^[、\s]+|[、\s]+$/g, '').trim();
    }).filter(function (s) { return s.length >= 6; });
  }

  /* Requirement ↔ evidence pairing: the actual persuasion payload.
     Greedy stock assignment — each resume line is used at most once, so three
     different requirements never all point at the same bullet. */
  /* The clause split and its tokens depend only on the posting, never on the
     resume, so they are computed once when the index is built. Rebuilding them
     for all 330 postings on every resume was most of a five-second match. */
  function jobUnits(scored, index) {
    var parsed = scored.parsed;
    if (parsed._units) return parsed._units;
    var reqs = [];
    parsed.must.forEach(function (t) { if (!isEligibility(t)) reqs.push({ text: t, type: 'must' }); });
    parsed.duty.forEach(function (t) { if (!isEligibility(t)) reqs.push({ text: t, type: 'duty', whole: t }); });

    // Compare clause by clause, but keep the parent requirement so the message
    // can quote a clause and still know which duty it came from.
    var units = [];
    reqs.forEach(function (req) {
      var cl = dutyClauses(req.text);
      if (!cl.length) cl = [req.text];
      cl.forEach(function (c) {
        if (c.length >= 6) units.push({ text: c, type: req.type, whole: req.whole || req.text });
      });
    });

    units.forEach(function (u) {
      // Match against the requirement alone. Folding the job title in let a
      // chemistry resume pair with a product posting through the word 实验室
      // in "未来生活实验室" — the title names the team, not the work.
      var rt = tokens(u.text);
      u.rKeys = rt;
      u.rSet = toSet(rt);
      u.rW = weightSum(rt, index.idf, 6);
      u.key = Object.keys(u.rSet).sort().join('|');
      // Three-character sequences of the requirement, computed once. Every
      // evidence line is checked against the same requirement. Folded first:
      // the spreadsheet stores some characters as Kangxi-radical variants
      // ("⽤户"), which NFKC maps to the ideograph the resume uses.
      var t = tighten(u.text).toLowerCase().replace(/\s+/g, '');
      var tri = u.tri = Object.create(null);
      for (var i = 0; i + 2 < t.length; i++) tri[t.slice(i, i + 3)] = 1;
    });
    // Keyed off the parsed posting, which lives in the index and survives a
    // second match on the same page.
    parsed._units = units;
    return units;
  }

  /* Admissibility of one resume line against one JD clause, as a strength
     value; 0 means "these two are not talking about the same work". Split out
     because the gap line must use exactly this test: the message may not say
     "no line of your resume answers this" about a clause the pair list would
     happily have quoted. */
  function pairValue(ev, req, idf) {
    var et = ev._tk || (ev._tk = tokens(ev.text));
    var eSet = ev._tset || (ev._tset = toSet(et));
    var ew = ev._tw || (ev._tw = weightSum(et, idf, 6));
    var sim = cosine(et, eSet, ew, req.rKeys, req.rSet, req.rW, idf);
    if (sim.score <= 0) return 0;
    // A pairing must share at least one specific word. Overlap built from
    // 完成/独立/负责 or from a bigram straddling two different words ("计提"
    // out of 设计提供 and 累计提交) says nothing about the work.
    var nSpec = specificCount(ev.text, req.rSet, et);
    if (!nSpec) return 0;
    // One shared word can still be two different things said close enough
    // together to overlap. When that is all there is, require three
    // consecutive characters of real work in common: "能独立完成交互原型
    // 设计" and "用 Axure 输出完整原型" share only filler spelled the same.
    // Two specific words in common is enough without that check — "输出页面
    // 原型" and "输出需求文档与原型 14 个页面" never share three characters,
    // and they are plainly the same piece of work.
    if (nSpec < 2 && !sharesSpecificTri(ev.text, req)) return 0;
    /* Ranking stays purely lexical: outcome bullets are recognised by
       concept further down and are deliberately not scored here, so every
       posting in the pool is compared on the same basis. */
    return sim.score * (ev.nums.length ? 1.3 : 1) * (req.type === 'must' ? 1.15 : 1);
  }

  function buildPairs(profile, scored, index) {
    var units = jobUnits(scored, index);
    var evidence = profile.evidence.filter(function (e) { return e.text.length >= 8; });
    var cand = [];
    units.forEach(function (req, ri) {
      var key = req.key;
      evidence.forEach(function (ev, ei) {
        var v = pairValue(ev, req, index.idf);
        if (v <= 0) return;
        cand.push({ ri: ri, ei: ei, v: v, key: key, req: req, rKeys: req.rKeys, eSet: ev._tset });
      });
    });
    cand.sort(function (a, b) { return b.v - a.v; });

    var usedReq = Object.create(null), usedEv = Object.create(null);
    var pairs = [];
    for (var i = 0; i < cand.length && pairs.length < 5; i++) {
      var c = cand[i];
      // One resume line answers one requirement. Reusing it for a second
      // requirement would present the same fact twice as two separate proofs.
      if (usedEv[c.ei]) continue;
      // Two clauses with the same words are the same requirement.
      if (usedReq[c.key]) continue;
      if (c.v < PAIR_MIN) break;
      usedEv[c.ei] = 1;
      usedReq[c.key] = 1;
      pairs.push({
        req: trimReq(c.req.text),
        whole: trimReq(c.req.whole),
        ev: evidence[c.ei].text,
        type: c.req.type,
        strength: c.v,
        hits: sharedWords(c.rKeys, c.eSet, 6)
      });
    }
    pairs.sort(function (a, b) { return b.strength - a.strength; });
    return pairs;
  }

  /* A duty bullet starts with what the person does. This list is the shape of
     the corpus, counted over all 3,100 duty clauses in the pool, not a guess:
     协助/参与/负责/整理/跟进 … head nearly every real bullet. It doubles as a
     rejector for the lines that are not duties at all but survive extraction —
     an address, a pay range, a company blurb — none of which begin with a verb. */
  var GAP_VERB = /^(负责|参与|协助|配合|独立|在.{0,12}指导下|完成|输出|产出|跟进|梳理|设计|搭建|维护|分析|策划|编写|汇总|整理|收集|推进|支持|调研|研究|管理|制定|执行|对接|分解|明确|沉淀|识别|优化|提升|推动|监控|统计|录入|验证|撰写|运营|开发|测试|配置|处理|编辑|复盘|迭代|拆解|评估|探索|记录|归档|上传|审核|检查|核对|核算|测算|标注|清洗|抽取|建立|完善|改进|改版|挖掘|组织|协调|联动|主导|统筹|承担|观察|反馈|试用|体验|接触|理解|学习|运用|利用|确保|保障|做好|参加|落地|承接|响应|答复|解答|沟通|洽谈|招募|培训|讲解|演示|汇报|总结|访谈|问卷|抽样|建模|调参|部署|接入|排期|验收|上线|发布|投放|拍摄|剪辑|绘图|排版|美化|校对|翻译|转录|录音|采集|巡检|盘点|补货|上架|下架|发货|退货|售后|回访|催付|签约|续费|开户|核销|结算|对账|报税|审计|招聘|面试|考勤|绩效)/;

  /* Split out because these are how a *requirement* is phrased, not a task:
     "具备主动推进意识，提高线索转化率" is an attitude, and quoting it as work
     the resume fails to answer would be quoting a personality. */
  var GAP_SOFT = /^(具备|熟悉|了解|熟练|掌握|能够|具有|善于|擅长|热爱|愿意|有较|有良|优秀的|良好的)/;

  /* A clause can open on a preposition ("根据排期发布…", "结合海外用户场景提出
     设想") and still be a task, but only when a task verb follows. "通过与小红书
     行业的深度运营诉求挖掘" is the other case — a fragment of a sentence the
     extractor cut, with nothing anyone would do in it. */
  var GAP_PREP = /^(根据|围绕|基于|结合|按照|针对|通过|面向|依据|借助|利用)/;
  /* Only verbs that cannot also be read as a noun, so that "…运营诉求挖掘"
     does not pass for a task on the strength of the word 运营 in the middle. */
  var GAP_CORE = /(负责|参与|协助|完成|输出|产出|整理|收集|汇总|制定|执行|发布|提出|编写|跟进|推进|开展|清洗|录入|核算|审核|汇报|答复|回复|拜访|讲解|演示|招募|培训)/;

  /* Extraction leaves spaces inside words the spreadsheet split ("多 模态",
     "操作⼿册"). A quote is shown to a person, so those go. */
  function tidyQuote(t) {
    var s = String(t);
    for (var i = 0; i < 3; i++) s = s.replace(/([一-鿿])\s+(?=[一-鿿])/g, '$1');
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  /* What this posting asks for that the resume does not answer at all — the
     counterpart of the pair list. Everything above says what lines up; this is
     the one place where the posting's own work can be reported as a fact
     instead of as a claim.

     The admissibility test is the pair list's own, at its own floor, so the
     message can never call a clause unanswered and then quote a line for it
     two lines earlier. A clause the list would have quoted is not a gap.

     Ranked by the weight of vocabulary the resume has never used, not by
     similarity: a clause can be "close" to a resume bullet and still ask for
     four things the resume has never done.

     The quoted text is the duty's own opening clause, never the highest-mass
     fragment. A fragment ranked on rarity lands mid-sentence ("包括格式标准化、
     字段对齐、数据清洗与校验") and reads as a broken quote; the opening clause
     is the bullet's title as the recruiter wrote it ("协助搭建客服处理流程"). */
  function gapCandidates(profile, scored) {
    var idf = scored.pool && scored.pool.idf;
    if (!idf) return [];
    var units = jobUnits(scored, { idf: idf });
    /* Pair lists get trimmed to fit the bubble; a clause answered by a pair
       that was dropped must not come back as a gap. */
    var answered = scored.allPairs || scored.pairs || [];
    var evidence = profile.evidence.filter(function (e) { return e.text.length >= 8; });
    var rset = profile._tset || (profile._tset = toSet(tokens(profile.raw)));

    var best = Object.create(null), order = [];
    /* A duty with even one answered clause is off the list. Its heading is the
       quota the pair list already printed, and saying "the resume has nothing
       for this" two lines under a quote of it is the one contradiction this
       line must never produce. */
    var covered = Object.create(null);
    answered.forEach(function (p) { if (p.whole) covered[p.whole] = 1; });
    units.forEach(function (u) {
      // Gates and benefits are not work. The gates already get their own line.
      if (u.type !== 'duty') return;
      var whole = trimReq(u.whole);
      if (covered[whole]) return;
      var t = trimReq(u.text);
      if (t.length < 8 || GAP_SKIP.test(t) || GAP_LEADIN.test(t)) return;
      for (var i = 0; i < answered.length; i++) {
        if (answered[i].req === t) return;
      }
      for (var j = 0; j < evidence.length; j++) {
        if (pairValue(evidence[j], u, idf) >= PAIR_MIN) return;
      }
      var miss = [];
      u.rKeys.forEach(function (k) {
        if (!GENERIC_BG[k] && !rset[k] && miss.indexOf(k) < 0) miss.push(k);
      });
      if (miss.length < 3) return;
      var mass = 0;
      miss.forEach(function (k) { mass += Math.min(idf[k] || 1.2, 6); });

      // Clause mass accumulates on the duty, so the duty is ranked by how much
      // of it the resume has never touched — all its clauses, not just one.
      if (!best[whole]) { best[whole] = { whole: whole, mass: 0, n: 0 }; order.push(whole); }
      best[whole].mass += mass / Math.sqrt(miss.length);
      best[whole].n += miss.length;
    });

    var out = [];
    order.forEach(function (whole) {
      var quote = gapQuote(whole);
      if (quote) out.push({ text: quote, whole: whole, n: best[whole].n, mass: best[whole].mass });
    });
    out.sort(function (a, b) { return b.mass - a.mass; });
    return out;
  }

  /* The opening of a duty, if it reads as a task. Returns '' when the duty has
     no clause that starts with a verb — the message would rather say nothing
     than quote a heading, an address or a fragment.

     A one-clause heading is often only a title ("策划商业化活动与增长实验").
     Clauses after it are carried along while they keep naming work, up to the
     quote budget, so the line lands as a task rather than a label. */
  function gapQuote(whole) {
    var cl = dutyClauses(whole);
    var i = 0, first = '';
    for (; i < cl.length && i < 3; i++) {
      var c = tidyQuote(cl[i]).replace(/^[-–—·•\s]+/, '');
      if (c.length < 8 || GAP_SKIP.test(c) || GAP_LEADIN.test(c) || GAP_SOFT.test(c)) continue;
      if (GAP_VERB.test(c)) { first = c; i++; break; }
      if (GAP_PREP.test(c) && GAP_CORE.test(c)) { first = c; i++; break; }
    }
    if (!first) return '';
    /* The first clause alone may already be past the budget. Cut it on its own
       punctuation rather than letting cutQuote do it later: cutQuote does not
       know grammar and will happily end a quote on "，对测试数据". */
    if (first.length > GAP_QUOTE) return trimToBound(first, GAP_QUOTE);
    var out = first;
    for (; i < cl.length && out.length < GAP_QUOTE; i++) {
      var nxt = tidyQuote(cl[i]).replace(/^[-–—·•\s]+/, '');
      if (nxt.length < 6 || GAP_SKIP.test(nxt) || GAP_LEADIN.test(nxt)) break;
      // A continuation clause that opens on a preposition or conjunction is a
      // fragment of the sentence before it ("…测试相关文档，对测试数据").
      if (GAP_STUB.test(nxt)) break;
      if (out.length + 1 + nxt.length > GAP_QUOTE) break;
      out += '，' + nxt;
    }
    return out;
  }

  /* Clause stubs: they begin with a linker and carry no verb of their own. */
  var GAP_STUB = /^[对并和与及以为在从向把将其或同随由至当较则而]/;

  /* Cut on punctuation, keeping at least ~12 characters so the result still
     names something. */
  function trimToBound(t, max) {
    var head = t.slice(0, max);
    var at = Math.max(head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf('：'));
    if (at < 12) at = max;
    return head.slice(0, at).replace(/[、，：\s]+$/, '');
  }

  /* Cut a quote on a clause boundary. Never mid-word, never with an ellipsis:
     the reader has the posting open in another window and will check. */
  function cutQuote(t, max) {
    return t.length <= max ? t : trimToBound(t, max);
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
    s = s.replace(/[，、]\s*$/, '');
    // No ellipsis here: a hard cut mid-clause is what makes a quote read as
    // unread. Keep the whole clause and let the caller cut on a boundary.
    return s;
  }

  /* A before/after number is the hardest thing an intern resume can say, and it
     is invisible to bigram overlap: "推动活跃用户从 1200 提升到 3100" shares
     almost nothing with a JD that says "用户增长". So it is not scored — it is
     looked up by concept and given its own line. Deliberately kept out of the
     pair list so that ranking stays purely lexical and comparable across the
     pool. */
  function pickResult(profile, scored) {
    var jd = (scored.parsed.duty || []).concat(scored.parsed.must || []).join(' ');
    var labels = resultConcepts(jd);
    if (!labels.length) return null;

    var outcome = profile.evidence.filter(function (e) { return outcomeIn(e.text); });
    if (!outcome.length) return null;

    // Score each outcome line, and record which metric family it speaks in,
    // so the sentence can name the JD concept this line actually answers.
    var best = null;
    outcome.forEach(function (e) {
      var clause = resultClause(e.text);
      var nums = (clause.match(/[\d.]+/g) || []).length;
      var fams = resultConcepts(e.text).map(function (c) { return RESULT_FAMILY[c] || 'other'; });
      // Prefer the line with the most concrete movement, then the shorter clause.
      var k = nums * 10 - clause.length / 100;
      if (!best || k > best.k) best = { k: k, clause: clause, text: e.text, nums: nums, fams: fams };
    });
    if (!best) return null;

    // The label is the JD's own primary metric, not whichever metric the
    // resume happens to satisfy. Hunting the JD for a concept that flatters the
    // resume is the same overreach in the other direction.
    var label = labels[0];
    var aligned = best.fams.indexOf(RESULT_FAMILY[label] || 'other') >= 0;
    return { label: label, clause: best.clause, full: best.text, aligned: aligned };
  }

  function match(profile, jobs, index) {
    var scored = jobs.map(function (job, idx) { return scoreJob(job, profile, index, idx); });
    scored.forEach(function (s) {
      var all = buildPairs(profile, s, index);
      /* Only pairs that clear PAIR_STRONG are quotable. A 0.15 pair shares
         nothing but a grammar word (参与 / 方案设计) and printing it next to a
         0.47 pair is what made the pitch read as padding: the heading promises
         N 处原话对得上, so N has to mean clauses the reader would defend in an
         interview. Everything downstream — the ranking depth, the heading
         count, the rarity line, the pick card, the rewritten lead — reads this
         filtered list, so they all agree on one bar. */
      s.pairs = all.filter(function (p) { return p.strength >= PAIR_STRONG; });
      /* Kept unfiltered so the gap list can still tell "this clause has no
         answer anywhere" from "the answer did not clear the bar". */
      s.allPairs = all;
      s.result = pickResult(profile, s);
    });
    /* Pool facts the message is allowed to quote. Counted once per match, from
       the same pair lists the reader can see. */
    var viable = scored.filter(function (s) { return !s.hardFail; });
    var ge = [0, 0, 0, 0];
    viable.forEach(function (s) { for (var k = 0; k <= Math.min(s.pairs.length, 3); k++) ge[k]++; });
    var topScore = viable.slice().sort(function (a, b) { return b.score - a.score; })[0];
    var pool = {
      viable: viable.length,
      ge: ge,
      /* Carried on the pool so the message can rebuild the gap list from a
         posting that came through structuredClone of the scored array. */
      idf: index.idf,
      top: topScore ? { score: topScore.score, pairs: topScore.pairs, job: topScore.job } : null
    };
    scored.forEach(function (s) { s.pool = pool; });
    /* Order by how well the case can be argued first, then by score. The whole
       product rests on the one posting pushed per day: if the duties cannot be
       matched to this resume, the message argues nothing, and a 74 分 posting
       with no evidence is worth less to the reader than a 67 分 one with two.
       Strict lexicographic on the number of quotable pairs — the old
       "only override the score when the gap is two pairs" rule was
       non-transitive, so a two-pair posting jumped to #1 while one-pair
       postings still sat behind the zero-pair mass, and the pick could be a
       posting the message then had to apologise for. Ordinal ranking only —
       this is not a probability. */
    var depthOf = function (s) { return Math.min(s.pairs.length, 3); };
    scored.forEach(function (s) { s.depth = depthOf(s); });
    scored.sort(function (a, b) {
      if (a.hardFail !== b.hardFail) return a.hardFail ? 1 : -1;
      return (b.depth - a.depth) || (b.score - a.score);
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
     close) easy on a single phone screen — and make the argument land. Every
     line is either a verbatim substring of the JD, a verbatim substring of the
     resume, or a count taken from the pool. No adjectives. */
  function buildMessage(profile, scored, rw) {
    var job = scored.job;
    var pairs = (scored.pairs || []).slice(0, 3);
    var out = [];

    out.push('今天这 1 个：' + job.c + ' · ' + job.t);
    var meta = [job.pay !== '平台未提供' ? job.pay : '', shortSched(job.sched), job.act].filter(Boolean).join(' · ');
    if (meta) out.push(meta);
    out.push('');

    if (pairs.length) {
      out.push('为什么是它（' + pairs.length + ' 处原话对得上）：');
      pairs.forEach(function (p, i) {
        var shared = toSet(p.hits || []);
        out.push((i + 1) + ' 它写「' + span(p.req, shared) + '」');
        out.push('   你写「' + span(p.ev, shared) + '」');
      });
    } else {
      out.push('为什么是它：库里没有哪个岗能和你简历里的经历对上一句原话。这段先别发。');
    }

    var res = scored.result;
    if (res) {
      var only = profile.evidence.filter(function (e) { return outcomeIn(e.text); }).length === 1;
      var tail = res.aligned ? '，正好是同一类指标' : '，跟它要的不是同一个数，只能算旁证';
      out.push('它要的是「' + res.label + '」，你简历里' + (only ? '唯一一条' : '') +
        '前后变化是：' + res.clause.replace(/^(推动|帮助)/, '') + tail + '。');
    }

    /* The other half of the argument. Without it the message reads as a
       salesman who only counted the hits: the reader finds the unanswered
       duty themselves two minutes later and stops believing the rest. Naming
       it first, in the posting's own words, is what makes the pair list above
       read as a measurement rather than a claim. */
    if (pairs.length) {
      var gap = gapCandidates(profile, scored)[0];
      if (gap) out.push('· 它还要「' + cutQuote(gap.text, 26) + '」，简历里没有能对上的一句。');
    }

    var fit = fitLine(profile, job);
    if (fit) out.push('· ' + fit);

    var risk = (scored.gates || []).filter(function (g) { return g.level === 'hard' || g.level === 'soft'; })[0];
    if (risk) out.push('· 要对好的一点：' + risk.text + '。');

    var pool = scored.pool;
    if (pool && pairs.length) {
      var depth = pairs.length;
      var digs = pool.ge[depth] !== undefined ? pool.ge[depth] : 0;
      var line = '· ' + pool.viable + ' 个能投的岗里，能对到 ' + depth + ' 段原话的只有 ' + digs + ' 个。';
      // Only contrast against a higher-scoring posting that argues for less —
      // otherwise the sentence contradicts the list it is explaining.
      var top = pool.top;
      if (top && top.score > scored.score && top.pairs.length < depth) {
        line += top.score + ' 分那个只对到 ' + top.pairs.length + ' 段。';
      }
      out.push(line);
    }

    out.push('');
    out.push('回「跟」我按这个岗重排简历发你，只动顺序和开头一段，公司、时间、数字不动。');
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

  /* How many distinct tokens of this fragment also appear in the reference. */
  function overlapCount(body, refSet) {
    var tk = tokens(body), got = Object.create(null), n = 0;
    for (var i = 0; i < tk.length; i++) {
      if (refSet[tk[i]] && !got[tk[i]]) { got[tk[i]] = 1; n++; }
    }
    return n;
  }

  /* How much of a clause's overlap is specific rather than filler. A quote is
     worth printing only when it carries words that name the work. Accepts an
     already-tokenised body so callers in the scoring loop do not pay twice. */
  function specificCount(body, refSet, tkArg) {
    var tk = tkArg || tokens(body), got = Object.create(null), n = 0;
    for (var i = 0; i < tk.length; i++) {
      if (refSet[tk[i]] && !got[tk[i]] && !GENERIC_BG[tk[i]]) { got[tk[i]] = 1; n++; }
    }
    return n;
  }

  /* The longest run of characters two strings share, plus whether that run is
     a word that names work rather than grammar. Two strings can agree on
     "独立完成" while talking about unrelated things, and a run that is nothing
     but filler must not count as the subject being the same. */
  /* True when the two strings share a three-character sequence that names work
     rather than grammar. Scanning the shorter string's trigrams against a set
     built from the longer one is linear in string length, unlike aligning the
     two strings, which is quadratic and made matching visibly slow. A run of
     filler ("独立完成") must not count: it is long and means nothing shared. */
  /* A trigram of filler ("独立完", "完成交") is not evidence of shared work. Read
     as three bigrams, the outer two are in the generic list and the middle one
     is not, so its absence from the list means nothing — only a positive hit on
     either outer bigram counts. */
  function specificTri(tri) {
    return !(GENERIC_BG[tri.slice(0, 2)] || GENERIC_BG[tri.slice(1, 3)]);
  }

  function sharesSpecificTri(a, req) {
    var x = tighten(a).toLowerCase().replace(/\s+/g, '');
    var tri = req.tri;
    if (x.length < 3 || !tri) return false;
    for (var j = 0; j + 2 < x.length; j++) {
      var t = x.slice(j, j + 3);
      if (tri[t] && specificTri(t)) return true;
    }
    return false;
  }

  /* Return the run of adjacent whole clauses that says the most shared things
     per character. Always a verbatim substring, always clause-bounded — never
     cut mid-clause, because a trailing ellipsis is what makes a quote read as
     if nothing was understood. Density rather than raw overlap, so the quote
     points at the shared words instead of pasting the whole bullet. */
  function span(text, refSet, maxChars) {
    var t = punct(String(text || '').replace(/\s+/g, ' ').trim())
      .replace(/^[-–—·•\s]+/, '')
      .replace(/^(岗位职责|工作职责|职位描述|任职要求|职位要求|岗位要求|任职资格)[:：]\s*/, '')
      .replace(/^[0-9]{1,2}[.、)）]\s*/, '')
      .replace(/[。；]\s*$/, '');
    var segs = t.split(/([，、；。])/);
    var frags = [];
    for (var i = 0; i < segs.length; i += 2) {
      var body = (segs[i] || '').trim();
      if (!body) continue;
      // Only specific shared words count toward the quote. Filler overlap
      // ("独立完成" appearing in both) would otherwise pull the window onto
      // a clause that shares grammar but not subject matter.
      frags.push({ body: body, delim: segs[i + 1] || '', hit: specificCount(body, refSet) });
    }
    if (!frags.length) return t;
    var cap = maxChars || 32;
    var best = null;
    for (var a = 0; a < frags.length; a++) {
      var hit = 0, joined = '';
      for (var b = a; b < frags.length && b < a + 3; b++) {
        var add = (b > a ? frags[b - 1].delim : '') + frags[b].body;
        // A first fragment is always taken whole, however long: shortening it
        // would mean cutting mid-clause, which is the exact failure we are
        // fixing. Only the extension of a run to a second clause is capped.
        if (joined && joined.length + add.length > cap) break;
        joined += add;
        hit += frags[b].hit;
        if (hit === 0) continue;
        // Shared words per character, linear: a second clause has to pay for
        // its own length, so a quote does not quietly swallow the whole bullet.
        // Divided by a floor as well, otherwise a two-character fragment wins
        // every time by being short — it printed 「注册」 where the sentence it
        // came from was 「…梳理 26 个关键事件…」 and said something.
        var score = hit / Math.max(joined.length, 12);
        if (!best || score > best.score) best = { score: score, text: joined };
      }
    }
    return best ? best.text : frags[0].body;
  }

  global.JOEngine = {
    normalize: normalize, tighten: tighten, tokens: tokens, numbersIn: numbersIn,
    detectSkills: detectSkills, familyOf: familyOf, parseResume: parseResume,
    splitJd: splitJd, buildIndex: buildIndex, match: match, rewrite: rewrite,
    buildMessage: buildMessage, checkNumbers: checkNumbers,
    guessResumeFamily: guessResumeFamily, trimReq: trimReq, outcomeIn: outcomeIn, span: span
  };
})(typeof window !== 'undefined' ? window : globalThis);
