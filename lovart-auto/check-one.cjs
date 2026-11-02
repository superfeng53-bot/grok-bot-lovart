#!/usr/bin/env node
const puppeteer = require('/home/box/tools/hypit/node_modules/.pnpm/puppeteer-core@25.10.0/node_modules/puppeteer-core');
const expected = process.argv[2] || '';
// TODAY: argv[3] > env LOVART_TODAY > current Asia/Shanghai date. Never edit this file per day.
function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const TODAY = (process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3])) ? process.argv[3]
  : (process.env.LOVART_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.LOVART_TODAY)) ? process.env.LOVART_TODAY
  : shanghaiToday();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseCreditsNum(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** DOM 可用积分：Layout A 右上近「升级」；Layout B 左侧栏底部闪电。
 * 禁止把续费日的「日」当成余额（L15 续费 2026-11-13 → 误读 topbar=13）。
 * Never use 本日/今日. */
function extractTopbarLightningFromDom() {
  const text = document.body.innerText || '';
  const poison = new Set();
  // 只毒化续费/有效期「日」，勿毒流水日期（免费号余额常=30）
  for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
  for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间)[^0-9\n]{0,16}\d{4}年\d{1,2}月(\d{1,2})日/g)) poison.add(Number(m[1]));
  const collect = (pred) => {
    const nums = [];
    for (const el of document.querySelectorAll('span, div, button, a, p')) {
      const r = el.getBoundingClientRect();
      if (!pred(r)) continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, '');
      if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
      const n = Number(t.replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      // 续费「日」1–31 污染顶栏：一律丢弃（真余额若恰为同日，靠侧栏/API/订阅卡）
      if (poison.has(n) && n <= 31) continue;
      nums.push({ n, x: r.x, y: r.y });
    }
    return nums;
  };
  const topRight = collect(r => r.y <= 140 && r.x >= 700 && r.width >= 6 && r.height >= 8 && r.height <= 60);
  // Layout B：左轨底部闪电旁数字（截图可见 ⚡100）
  const sideBot = collect(r => r.x < 240 && r.y > 480 && r.width >= 6 && r.height >= 8 && r.height <= 80);
  const pool = [...sideBot, ...topRight].sort((a, b) => b.n - a.n || b.x - a.x);
  if (pool.length) return pool[0].n;
  let m = text.match(/([\d,]{1,9})\s*\n\s*升级/);
  if (!m) m = text.match(/(?:试用 Lovart 新版本\n)?([\d,]{1,9})\n升级/);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && !(poison.has(n) && n <= 31)) return n;
  }
  return null;
}

/** 订阅/账户弹层内，闪电旁的可用总额（补 L15 文本行缺独立 100 的洞）。 */
function extractModalUsableFromDom() {
  const text = document.body.innerText || '';
  const poison = new Set();
  for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
  const cands = [];
  for (const el of document.querySelectorAll('span, div, p, button')) {
    const r = el.getBoundingClientRect();
    // 弹层主区（避开顶栏与最底）
    if (r.y < 60 || r.y > 520 || r.x < 260 || r.x > 1100) continue;
    if (r.width < 8 || r.height < 10 || r.height > 120) continue;
    const t = (el.innerText || '').trim().replace(/\s+/g, '');
    if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
    const n = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 30) continue;
    if (poison.has(n) && n <= 31) continue;
    // 邻近是否有闪电/积分语境
    const parent = (el.parentElement && (el.parentElement.innerText || '')) || '';
    const ctx = parent.slice(0, 80);
    const nearLightning = /⚡|积分|Credits|Starter|可用|余额|Power/i.test(ctx) ||
      !!(el.parentElement && el.parentElement.querySelector('svg, img, [class*="lightning"], [class*="bolt"], [class*="power"]'));
    if (nearLightning || n >= 100) cands.push({ n, y: r.y, x: r.x, nearLightning });
  }
  if (!cands.length) return null;
  // 优先带闪电语境且较大的数；排除紧挨「本日/今日积分余额」标签正下方的「本日」行（仍可作回退）
  cands.sort((a, b) => (b.nearLightning - a.nearLightning) || (b.n - a.n) || (a.y - b.y));
  return cands[0].n;
}

/** Subscription / account page total credits; exclude 本日/今日/本月 daily/monthly remaining. */
function extractTotalBalanceFromText(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  // Explicit total-ish labels (not 本日/今日/本月)
  const labelRe = /(?:^|[^本今])((?:账户)?积分(?:总额|余额)?|可用积分|剩余积分|Credits?)[:：\s]*([\d,]+)/i;
  for (const line of lines) {
    if (/(?:本日|今日|本月)积分/.test(line)) continue;
    const m = line.match(/(?:账户)?积分(?:总额|总余额|余额)?[:：\s]*([\d,]+)/i) || line.match(/(?:可用|剩余)积分[:：\s]*([\d,]+)/i);
    if (m) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Standalone comma-formatted credit like 2,070 on plan/subscribe header
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[\d,]{3,9}$/.test(l) && l.includes(',')) {
      const n = Number(l.replace(/,/g, ''));
      if (Number.isFinite(n) && n >= 100) {
        // nearby context hint
        const ctx = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
        if (/积分|Credits|Starter|升级|订阅/i.test(ctx) && !/(?:本日|今日|本月)积分/.test(ctx)) return n;
      }
    }
  }
  return null;
}


function parseBonus(lines) {
  let lastBonus = null;
  const normDate = (s) => {
    if (!s) return null;
    let m = String(s).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return null;
  };
  const takeFromBlock = (block) => {
    let status = null, amount = null, date = null, time = null;
    for (const raw of block) {
      const l = String(raw || '').trim();
      if (l === '已获取' || l === '已消耗' || /已获取/.test(l)) status = /已消耗/.test(l) && !/已获取/.test(l) ? '已消耗' : ( /已获取/.test(l) ? '已获取' : status);
      let m = l.match(/(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2})/);
      if (m) { date = normDate(m[1]); time = m[2].padStart(5,'0'); continue; }
      m = l.match(/^(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})$/);
      if (m) { date = normDate(m[1]); continue; }
      m = l.match(/^(\d{1,2}:\d{2})$/);
      if (m) { time = m[1].padStart(5,'0'); continue; }
      m = l.match(/\+\s*(\d+)/);
      if (m) { amount = Number(m[1]); continue; }
    }
    return { status, amount, date, time };
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/Daily Login Bonus|每日登录|登录奖励/i.test(lines[i])) continue;
    // 旧版标题很短；新版可能把状态/日期挤在同一行，放宽到 200
    if (lines[i].length > 200) continue;
    const block = lines.slice(i, i + 8);
    let { status, amount, date, time } = takeFromBlock(block);
    // 单行紧凑：Daily Login Bonus 已获取 2026-10-28 09:07 +100
    if (amount == null || !date || status !== '已获取') {
      const one = block.join(' ').replace(/\s+/g, ' ');
      let m = one.match(/(?:Daily Login Bonus|每日登录|登录奖励)[^\d+]*?(已获取|已消耗)[^\d]*?(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2})[^\d+]*\+\s*(\d+)/i);
      if (!m) m = one.match(/(?:Daily Login Bonus|每日登录|登录奖励)[^\d+]*?\+\s*(\d+)[^\d]*?(已获取|已消耗)[^\d]*?(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2})/i);
      if (m) {
        if (m.length === 5 && /已获取|已消耗/.test(m[1])) {
          status = m[1]; date = normDate(m[2]); time = m[3].padStart(5,'0'); amount = Number(m[4]);
        } else if (m.length === 5) {
          amount = Number(m[1]); status = m[2]; date = normDate(m[3]); time = m[4].padStart(5,'0');
        }
      }
    }
    if (status !== '已获取' || amount == null || !date) continue;
    if (date === TODAY) {
      return { bonus: amount, claimed_time: time, last_bonus: `${date} ${time || ''}` };
    }
    // 保留日期最新的一条作 last（避免列表从旧到新时卡住旧日期）
    const cand = `${date} ${time || ''} +${amount}`.trim();
    if (!lastBonus || cand.slice(0,10) > lastBonus.slice(0,10)) lastBonus = cand;
  }
  for (const l of lines) {
    const one = l.replace(/\s+/g, ' ');
    let m = one.match(/(?:Daily Login Bonus|每日登录|登录奖励).*?已获取.*?(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2}).*?\+\s*(\d+)/i);
    if (!m) m = one.match(/(?:Daily Login Bonus|每日登录|登录奖励).*?\+\s*(\d+).*?已获取.*?(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2})/i);
    if (m) {
      let date, time, amount;
      if (m[0].indexOf('已获取') < m[0].indexOf('+') || /^\d{4}/.test(m[1])) {
        // first form: date,time,amount OR if second form groups differ
      }
      if (/^\d{4}/.test(m[1])) { date = normDate(m[1]); time = m[2].padStart(5,'0'); amount = Number(m[3]); }
      else { amount = Number(m[1]); date = normDate(m[2]); time = m[3].padStart(5,'0'); }
      if (date === TODAY) return { bonus: amount, claimed_time: time, last_bonus: `${date} ${time}` };
      const cand = `${date} ${time} +${amount}`;
      if (!lastBonus || date > lastBonus.slice(0,10)) lastBonus = cand;
    }
  }
  return { bonus: null, claimed_time: null, last_bonus: lastBonus };
}

async function dismissPopups(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const btn = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, div, span, a')) {
        const t = (el.innerText || '').trim();
        if (t === '我知道了' || t === '知道了') {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 10) return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
        }
      }
      return null;
    });
    if (!btn) break;
    await page.mouse.click(btn.x, btn.y);
    await sleep(700);
  }
  // Close Google Translate X if present (approx)
  try {
    await page.mouse.click(1109, 103);
    await sleep(300);
  } catch (_) {}
}

async function findTopRightAvatar(page) {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.x > 1050 && r.y < 220 && r.width >= 20 && r.width <= 56 && r.height >= 20;
    });
    if (imgs[0]) {
      const r = imgs[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, alt: imgs[0].alt || '' };
    }
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.x > 1200 && r.y < 150 && r.width >= 24 && r.width <= 48 && r.height >= 24 && r.height <= 48) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, alt: 'btn' };
      }
    }
    return null;
  });
}

async function detectUi(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    // Classic: top-right 升级 + avatar, often "试用 Lovart 新版本"
    const hasTopRightUpgrade = /试用 Lovart 新版本|升级/.test(text);
    const topAvatar = [...document.querySelectorAll('img')].some(el => {
      const r = el.getBoundingClientRect();
      return r.x > 1050 && r.y < 220 && r.width >= 20;
    });
    const hasClassicSwitch = /返回 Lovart 经典版/.test(text);
    const hasNewSidebar = /创建团队|账户管理/.test(text) && !topAvatar;
    return {
      classic: !!(topAvatar && hasTopRightUpgrade),
      topAvatar,
      hasClassicSwitch,
      hasNewSidebar,
      url: location.href,
    };
  });
}

async function clickText(page, labels, opts = {}) {
  const maxH = opts.maxH || 80;
  const found = await page.evaluate((labels, maxH) => {
    for (const el of document.querySelectorAll('button, div, span, a, [role="menuitem"], li')) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (labels.includes(t)) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 8 && r.height < maxH) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
        }
      }
    }
    // partial match for longer rows
    for (const el of document.querySelectorAll('button, div, span, a, [role="menuitem"], li')) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      for (const lab of labels) {
        if (t.includes(lab) && t.length < 60) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 8 && r.height < maxH) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, t };
          }
        }
      }
    }
    return null;
  }, labels, maxH);
  if (found) {
    await page.mouse.click(found.x, found.y);
    await sleep(opts.wait || 900);
    return found;
  }
  return null;
}

async function switchToClassic(page) {
  // If already classic (top-right avatar), skip
  let ui = await detectUi(page);
  if (ui.classic || ui.topAvatar) {
    return { switched: false, reason: 'already_classic' };
  }

  // NEW UI: open account menu then click 返回 Lovart 经典版
  const vh = await page.evaluate(() => window.innerHeight);
  // Try expanded account row
  await page.mouse.click(30, Math.min(169, vh - 20));
  await sleep(600);
  await page.mouse.click(100, vh - 50);
  await sleep(1100);

  let sw = await clickText(page, ['返回 Lovart 经典版'], { wait: 800 });
  if (!sw) {
    // Collapsed rail avatar
    await page.mouse.click(30, vh - 40);
    await sleep(1100);
    sw = await clickText(page, ['返回 Lovart 经典版'], { wait: 800 });
  }
  if (!sw) {
    return { switched: false, reason: 'switch_link_not_found' };
  }
  // Confirm 继续
  await sleep(500);
  const cont = await clickText(page, ['继续'], { wait: 2000, maxH: 80 });
  if (!cont) {
    // fallback coords from skill
    await page.mouse.click(803, 454);
    await sleep(2000);
  }
  await sleep(2500);
  // Wait for classic home
  for (let i = 0; i < 20; i++) {
    ui = await detectUi(page);
    if (ui.classic || ui.topAvatar) break;
    await dismissPopups(page);
    await sleep(500);
  }
  return { switched: true, reason: 'switched', classic: !!(ui.classic || ui.topAvatar) };
}

async function waitReady(page) {
  for (let i = 0; i < 30; i++) {
    const st = await page.evaluate(() => {
      const login = location.href.includes('/login');
      const chromeErr = location.href.startsWith('chrome-error://');
      const err = /ERR_[A-Z_]{4,}|This site can.t be reached|无法访问此网站|198\.18\.\d+\.\d+/.test(document.body.innerText || '');
      const hasUpgrade = /升级|试用 Lovart/.test(document.body.innerText || '');
      const hasModal = /我知道了/.test(document.body.innerText || '');
      const imgs = [...document.querySelectorAll('img')].some(el => {
        const r = el.getBoundingClientRect();
        return r.x > 1050 && r.y < 220 && r.width >= 20;
      });
      const hasSidebar = /创建团队|我的素材|返回 Lovart/.test(document.body.innerText || '');
      return { login, err: err || chromeErr, hasUpgrade, hasModal, imgs, hasSidebar, url: location.href };
    });
    if (st.login) return st;
    if (st.err) return st;
    if (st.imgs || st.hasSidebar || (st.hasUpgrade && !st.hasModal && i > 4)) return st;
    if (st.hasModal) {
      await dismissPopups(page);
    }
    await sleep(500);
  }
  return await page.evaluate(() => ({
    login: location.href.includes('/login'),
    err: /ERR_[A-Z_]{4,}|This site can.t be reached|无法访问此网站|198\.18\.\d+\.\d+/.test(document.body.innerText || ''),
    url: location.href,
  }));
}

async function openAccountMenu(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissPopups(page);
    const avatar = await findTopRightAvatar(page);
    if (avatar) {
      await page.mouse.click(avatar.x, avatar.y);
      await sleep(1100);
      if (await page.evaluate(() => /账户管理|退出登录/.test(document.body.innerText || ''))) {
        return { layout: 'A', avatar };
      }
      await page.mouse.click(avatar.x, avatar.y);
      await sleep(1100);
      if (await page.evaluate(() => /账户管理|退出登录/.test(document.body.innerText || ''))) {
        return { layout: 'A', avatar };
      }
    }
    const vh = await page.evaluate(() => window.innerHeight);
    await page.mouse.click(30, Math.min(169, vh - 20));
    await sleep(600);
    await page.mouse.click(100, vh - 50);
    await sleep(1100);
    if (await page.evaluate(() => /账户管理|退出登录/.test(document.body.innerText || ''))) {
      return { layout: 'B' };
    }
    await page.mouse.click(30, vh - 40);
    await sleep(1100);
    if (await page.evaluate(() => /账户管理|退出登录/.test(document.body.innerText || ''))) {
      return { layout: 'B-rail' };
    }
    await sleep(800);
  }
  return { layout: 'unknown' };
}

async function openSubscription(page) {
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="menuitem"], button, a, div, span, li')];
    for (const el of candidates) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t === '账户管理') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.height < 60) { el.click(); return; }
      }
    }
    for (const el of candidates) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (/^(Free|Starter)\b/.test(t) && t.length < 40) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.y > 150 && r.y < 500) { el.click(); return; }
      }
    }
  });
  await sleep(1600);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [role="tab"], div, span, a')) {
      if ((el.innerText || '').trim() === '订阅') { el.click(); return; }
    }
  });
  await sleep(1200);
  // Capture total balance on 订阅页 BEFORE switching to 用量 (本日余额在用量页，易误当总额)
  const subSnap = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const topbar = (typeof extractTopbarLightningFromDom === 'function')
      ? extractTopbarLightningFromDom()
      : null;
    // inline copy — page.evaluate cannot see outer helpers
    function topbarLocal() {
      const poison = new Set();
      // 只毒化续费/有效期「日」，勿毒流水日期（免费号余额常=30）
      for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
      for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间)[^0-9\n]{0,16}\d{4}年\d{1,2}月(\d{1,2})日/g)) poison.add(Number(m[1]));
      const collect = (pred) => {
        const nums = [];
        for (const el of document.querySelectorAll('span, div, button, a, p')) {
          const r = el.getBoundingClientRect();
          if (!pred(r)) continue;
          const t = (el.innerText || '').trim().replace(/\s+/g, '');
          if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
          const n = Number(t.replace(/,/g, ''));
          if (!Number.isFinite(n) || n <= 0) continue;
          if (poison.has(n) && n <= 31) continue;
          nums.push({ n, x: r.x, y: r.y });
        }
        return nums;
      };
      const topRight = collect(r => r.y <= 140 && r.x >= 700 && r.width >= 6 && r.height >= 8 && r.height <= 60);
      const sideBot = collect(r => r.x < 240 && r.y > 480 && r.width >= 6 && r.height >= 8 && r.height <= 80);
      const pool = [...sideBot, ...topRight].sort((a, b) => b.n - a.n || b.x - a.x);
      if (pool.length) return pool[0].n;
      let m = text.match(/([\d,]{1,9})\s*\n\s*升级/);
      if (!m) m = text.match(/(?:试用 Lovart 新版本\n)?([\d,]{1,9})\n升级/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0 && !(poison.has(n) && n <= 31)) return n;
      }
      return null;
    }
    function modalUsableLocal() {
      const poison = new Set();
      for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
      const cands = [];
      for (const el of document.querySelectorAll('span, div, p, button')) {
        const r = el.getBoundingClientRect();
        if (r.y < 60 || r.y > 520 || r.x < 260 || r.x > 1100) continue;
        if (r.width < 8 || r.height < 10 || r.height > 120) continue;
        const t = (el.innerText || '').trim().replace(/\s+/g, '');
        if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
        const n = Number(t.replace(/,/g, ''));
        if (!Number.isFinite(n) || n < 30) continue;
        if (poison.has(n) && n <= 31) continue;
        const parentTxt = ((el.parentElement && el.parentElement.innerText) || '').slice(0, 100);
        const near = /⚡|积分|Credits|Starter|可用|余额|Power/i.test(parentTxt) ||
          !!(el.parentElement && el.parentElement.querySelector('svg, img, [class*="lightning"], [class*="bolt"], [class*="power"]'));
        // 跳过「本日/今日积分余额」正下方的本日额度标签值：仍允许 ≥100 作为候选（充值号本日=总额常见）
        const labelish = /(?:本日|今日|本月)积分余额/.test(parentTxt);
        if (labelish && n < 100) continue;
        cands.push({ n, near, y: r.y });
      }
      if (!cands.length) return null;
      cands.sort((a, b) => (b.near - a.near) || (b.n - a.n) || (a.y - b.y));
      return cands[0].n;
    }
    function totalFromText(text) {
      const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
      // 订阅卡总额：在「本日积分余额」之前的大数字（如 2,100 / 2100），勿被后续本日行上下文误杀
      const todayIdx = lines.findIndex(l => /^(?:本日|今日)积分余额/.test(l));
      const head = todayIdx >= 0 ? lines.slice(0, todayIdx) : lines.slice(0, 40);
      for (let i = 0; i < head.length; i++) {
        const l = head[i];
        if (!/^[\d,]{3,9}$/.test(l)) continue;
        const n = Number(l.replace(/,/g, ''));
        if (!Number.isFinite(n) || n < 100) continue;
        const prev = head[i - 1] || '';
        const next = head[i + 1] || '';
        // 数字可能在「升级」和「充值」之间，不要求紧挨「生效中」
        if (/升级|充值|生效中|下次续费|Starter|Free|订阅/.test(prev + ' ' + next) || /升级|充值|生效中|下次续费/.test(prev) || /升级|充值|生效中|下次续费/.test(next)) return n;
      }
      let bestComma = null;
      for (const l of head) {
        if (/^[\d,]{3,9}$/.test(l) && l.includes(',')) {
          const n = Number(l.replace(/,/g, ''));
          if (Number.isFinite(n) && n >= 100 && (bestComma == null || n > bestComma)) bestComma = n;
        }
      }
      if (bestComma != null) return bestComma;
      // 「升级」…数字…「充值」夹心（订阅卡常见，不要求紧挨生效中）
      {
        const upIdx = head.findIndex(l => l === '升级' || /^升级/.test(l));
        const payIdx = head.findIndex(l => l === '充值' || /^充值/.test(l));
        if (upIdx >= 0 && payIdx > upIdx) {
          let best = null;
          for (let i = upIdx + 1; i < payIdx; i++) {
            const l = head[i];
            if (!/^[\d,]{3,9}$/.test(l)) continue;
            const n = Number(l.replace(/,/g, ''));
            if (Number.isFinite(n) && n >= 100 && (best == null || n > best)) best = n;
          }
          if (best != null) return best;
        }
      }
      // head 里紧挨续费/升级/充值行的纯数字（无逗号的 2100）
      for (let i = 0; i < head.length; i++) {
        const l = head[i];
        if (!/^\d{3,7}$/.test(l)) continue;
        const n = Number(l);
        const prev = head[i - 1] || '';
        const next = head[i + 1] || '';
        if (/升级|充值|生效中|下次续费/.test(prev) || /升级|充值|生效中|下次续费/.test(next)) return n;
      }
      for (const line of lines) {
        if (/(?:本日|今日|本月)积分/.test(line)) continue;
        const m = line.match(/(?:账户)?积分(?:总额|总余额)[:：\s]*([\d,]+)/i) || line.match(/(?:可用|剩余)积分[:：\s]*([\d,]+)/i);
        if (m) {
          const n = Number(m[1].replace(/,/g, ''));
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return null;
    }
    const _tb = topbarLocal();
    const _tf = totalFromText(text);
    const _mu = modalUsableLocal();
    const _sub = [_tf, _mu].filter(x => typeof x === 'number' && x > 0);
    return {
      topbar_lightning: _tb,
      sub_total: _sub.length ? Math.max(..._sub) : null,
      modal_usable: _mu,
      sub_lines_hint: (text.split('\n').map(s => s.trim()).filter(Boolean)).filter(l => /积分|Credits|[\d,]{3,}/i.test(l)).slice(0, 40),
      topbar_debug: { poisonDays: [...(function(){ const p=new Set(); for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间)[^0-9\n]{0,16}20\d{2}-\d{2}-(\d{2})/g)) p.add(Number(m[1])); return p; })()] },
    };
  });
  page.__lovart_sub_snap = subSnap;
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [role="tab"], div, span, a')) {
      if ((el.innerText || '').trim() === '用量') { el.click(); return; }
    }
  });
  await sleep(1800);
  return subSnap;
}

(async () => {
  const out = {
    email_seen: null, bonus: null, claimed_time: null, balance: null,
    today_remaining: null, month_remaining: null, total_balance: null,
    topbar_lightning: null, plan: null, renewal: null, last_bonus: null,
    status: 'ok', note: '', layout: null, switched_to_classic: false,
  };
  try {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9224', defaultViewport: null });
    const pages = await browser.pages();
    let page = pages.find(p => (p.url() || '').includes('lovart.ai')) || pages[0];
    if (!page) { out.status = 'blocked'; out.note = 'no page'; console.log(JSON.stringify(out)); return; }
    await page.bringToFront();
    if (!(page.url() || '').includes('/zh/home')) {
      await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    await sleep(1500);
    let ready = await waitReady(page);
    if (ready.login) {
      out.status = 'login_required'; out.note = 'login page ' + (ready.url || page.url());
      console.log(JSON.stringify(out)); await browser.disconnect(); return;
    }
    if (ready.err) {
      out.status = 'blocked'; out.note = 'connection error page';
      console.log(JSON.stringify(out)); await browser.disconnect(); return;
    }
    await dismissPopups(page);

    // Always prefer CLASSIC UI
    const sw = await switchToClassic(page);
    out.switched_to_classic = !!sw.switched;
    if (sw.switched) {
      await dismissPopups(page);
      ready = await waitReady(page);
      if (ready.login) {
        out.status = 'login_required'; out.note = 'login after classic switch';
        console.log(JSON.stringify(out)); await browser.disconnect(); return;
      }
      if (ready.err) {
        out.status = 'blocked'; out.note = 'connection error after classic switch';
        console.log(JSON.stringify(out)); await browser.disconnect(); return;
      }
    }

    let menu = await openAccountMenu(page);
    out.layout = menu.layout;
    if (menu.layout === 'unknown') {
      await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(2500);
      await waitReady(page);
      await dismissPopups(page);
      // retry classic switch once
      await switchToClassic(page);
      await dismissPopups(page);
      menu = await openAccountMenu(page);
      out.layout = menu.layout;
      if (menu.layout === 'unknown') {
        out.status = 'blocked'; out.note = 'could not open account menu';
        console.log(JSON.stringify(out)); await browser.disconnect(); return;
      }
    }

    const menuInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const emails = [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)].map(m => m[0]);
      return { emails: [...new Set(emails)] };
    });
    out.email_seen = menuInfo.emails[0] || null;
    if (expected && out.email_seen && out.email_seen.toLowerCase() !== expected.toLowerCase()) {
      out.status = 'email_mismatch';
      out.note = `expected ${expected} got ${out.email_seen}`;
      console.log(JSON.stringify(out)); await browser.disconnect(); return;
    }

    const subSnap = await openSubscription(page);

    // 2026-10-30：登录态同源 cookie 拉 member/account，usablePower 作权威可用总额
    let apiAccount = null;
    try {
      apiAccount = await page.evaluate(async () => {
        try {
          const r = await fetch('https://www.lovart.ai/api/www/lovart/member/account', {
            method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' },
          });
          const j = await r.json().catch(() => null);
          return { ok: r.ok, status: r.status, body: j };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      });
    } catch (e) {
      apiAccount = { ok: false, error: String(e && e.message || e) };
    }
    function pickApiPower(body) {
      if (!body || typeof body !== 'object') return null;
      const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x
        : (x != null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null));
      // 深搜 usablePower / usable_power（接口偶发包一层）
      const found = {};
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 5) return;
        for (const [k, v] of Object.entries(obj)) {
          const lk = String(k).toLowerCase();
          if (lk === 'usablepower' || lk === 'usable_power') found.usablePower = num(v);
          else if (lk === 'usedpower' || lk === 'used_power') found.usedPower = num(v);
          else if (lk === 'totalpower' || lk === 'total_power') found.totalPower = num(v);
          else if (lk === 'powerallocatedtoday' || lk === 'power_allocated_today') found.powerAllocatedToday = num(v);
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(body, 0);
      if (found.usablePower == null && found.usedPower == null && found.totalPower == null) {
        const d = (body.data && typeof body.data === 'object') ? body.data
          : (body.result && typeof body.result === 'object') ? body.result
          : body;
        found.usablePower = num(d.usablePower ?? d.usable_power);
        found.usedPower = num(d.usedPower ?? d.used_power);
        found.totalPower = num(d.totalPower ?? d.total_power);
        found.powerAllocatedToday = num(d.powerAllocatedToday ?? d.power_allocated_today);
      }
      return found;
    }
    // 主接口失败时再试备用路径（同源 cookie）
    if (!(apiAccount && apiAccount.ok && apiAccount.body)) {
      try {
        const alt = await page.evaluate(async () => {
          const urls = [
            'https://www.lovart.ai/api/www/lovart/member/account',
            'https://www.lovart.ai/api/www/member/account',
            'https://www.lovart.ai/api/lovart/member/account',
          ];
          for (const u of urls) {
            try {
              const r = await fetch(u, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } });
              const j = await r.json().catch(() => null);
              if (r.ok && j) return { ok: true, status: r.status, body: j, url: u };
            } catch (_) {}
          }
          return { ok: false, error: 'all_alt_failed' };
        });
        if (alt && alt.ok) apiAccount = alt;
      } catch (_) {}
    }
    const apiPow = pickApiPower(apiAccount && apiAccount.body);
    const bodyCode = apiAccount && apiAccount.body && typeof apiAccount.body === 'object' ? apiAccount.body.code : null;
    const bodyMsg = apiAccount && apiAccount.body && typeof apiAccount.body === 'object' ? apiAccount.body.msg : null;
    const apiLoggedIn = !!(apiAccount && apiAccount.ok && apiAccount.body && (bodyCode === 0 || bodyCode === '0' || (bodyCode == null && apiAccount.body.data)));
    out.api_account_meta = {
      ok: apiLoggedIn,
      http_ok: !!(apiAccount && apiAccount.ok),
      status: apiAccount && apiAccount.status,
      code: bodyCode,
      msg: bodyMsg,
      url: apiAccount && apiAccount.url,
      error: apiAccount && apiAccount.error,
      bodyKeys: apiAccount && apiAccount.body && typeof apiAccount.body === 'object' ? Object.keys(apiAccount.body).slice(0, 20) : null,
    };
    if (apiLoggedIn && apiPow && (apiPow.usablePower != null || apiPow.totalPower != null || apiPow.usedPower != null)) {
      out.usablePower = apiPow.usablePower;
      out.usedPower = apiPow.usedPower;
      out.totalPower = apiPow.totalPower;
      out.powerAllocatedToday = apiPow.powerAllocatedToday;
    } else {
      out.api_account_error = bodyMsg || (apiAccount && (apiAccount.error || apiAccount.status)) || 'no_power_fields';
      out.usablePower = null;
    }

    // 2026-10-25：用量页偶发未刷出「本日积分余额 / 今日 DLB」，轮询最多 ~12s 再点一次「用量」
    let hasUsage = false;
    for (let i = 0; i < 6; i++) {
      hasUsage = await page.evaluate(() => /Daily Login Bonus|本日积分余额|本月积分余额/.test(document.body.innerText || ''));
      if (hasUsage) break;
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, [role="tab"], div, span, a')) {
          if ((el.innerText || '').trim() === '用量') { el.click(); return; }
        }
      });
      await sleep(2000);
    }

    const ledger = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const emails = [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)].map(m => m[0]);
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      const plan = (text.match(/\b(Free|Starter)\b/) || [])[1] || null;
      // 本日/今日 — 禁止当作总余额
      const todayBal = (text.match(/(?:本日|今日)积分余额[:：\s]*([\d,]+)/) || [])[1];
      const monthBal = (text.match(/本月积分余额[:：\s]*([\d,]+)/) || [])[1];
      let renewal = null;
      const m1 = text.match(/有效期至\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
      const m2 = text.match(/下次续费[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
      if (m1) renewal = m1[1];
      else if (m2) renewal = m2[1];
      function topbarLocal() {
        const poison = new Set();
        // 只毒化续费/有效期「日」，勿毒流水日期（免费号余额常=30）
        for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
        for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间)[^0-9\n]{0,16}\d{4}年\d{1,2}月(\d{1,2})日/g)) poison.add(Number(m[1]));
        const collect = (pred) => {
          const nums = [];
          for (const el of document.querySelectorAll('span, div, button, a, p')) {
            const r = el.getBoundingClientRect();
            if (!pred(r)) continue;
            const t = (el.innerText || '').trim().replace(/\s+/g, '');
            if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
            const n = Number(t.replace(/,/g, ''));
            if (!Number.isFinite(n) || n <= 0) continue;
            if (poison.has(n) && n <= 31) continue;
            nums.push({ n, x: r.x, y: r.y });
          }
          return nums;
        };
        const topRight = collect(r => r.y <= 140 && r.x >= 700 && r.width >= 6 && r.height >= 8 && r.height <= 60);
        const sideBot = collect(r => r.x < 240 && r.y > 480 && r.width >= 6 && r.height >= 8 && r.height <= 80);
        const pool = [...sideBot, ...topRight].sort((a, b) => b.n - a.n || b.x - a.x);
        if (pool.length) return pool[0].n;
        let m = text.match(/([\d,]{1,9})\s*\n\s*升级/);
        if (!m) m = text.match(/(?:试用 Lovart 新版本\n)?([\d,]{1,9})\n升级/);
        if (m) {
          const n = Number(m[1].replace(/,/g, ''));
          if (Number.isFinite(n) && n > 0 && !(poison.has(n) && n <= 31)) return n;
        }
        return null;
      }
      function modalUsableLocal() {
        const poison = new Set();
        for (const m of text.matchAll(/(?:下次续费|有效期至|续费时间|Renew)[^0-9\n]{0,16}20\d{2}-(\d{2})-(\d{2})/gi)) poison.add(Number(m[2]));
        const cands = [];
        for (const el of document.querySelectorAll('span, div, p, button')) {
          const r = el.getBoundingClientRect();
          if (r.y < 60 || r.y > 520 || r.x < 260 || r.x > 1100) continue;
          if (r.width < 8 || r.height < 10 || r.height > 120) continue;
          const t = (el.innerText || '').trim().replace(/\s+/g, '');
          if (!/^[\d,]+$/.test(t) || t.length > 9) continue;
          const n = Number(t.replace(/,/g, ''));
          if (!Number.isFinite(n) || n < 30) continue;
          if (poison.has(n) && n <= 31) continue;
          const parentTxt = ((el.parentElement && el.parentElement.innerText) || '').slice(0, 100);
          const near = /⚡|积分|Credits|Starter|可用|余额|Power/i.test(parentTxt) ||
            !!(el.parentElement && el.parentElement.querySelector('svg, img, [class*="lightning"], [class*="bolt"], [class*="power"]'));
          const labelish = /(?:本日|今日|本月)积分余额/.test(parentTxt);
          if (labelish && n < 100) continue;
          cands.push({ n, near, y: r.y });
        }
        if (!cands.length) return null;
        cands.sort((a, b) => (b.near - a.near) || (b.n - a.n) || (a.y - b.y));
        return cands[0].n;
      }
      function totalFromText(text) {
        const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
        // 订阅卡总额：在「本日积分余额」之前的大数字（如 2,100 / 2100），勿被后续本日行上下文误杀
        const todayIdx = lines.findIndex(l => /^(?:本日|今日)积分余额/.test(l));
        const head = todayIdx >= 0 ? lines.slice(0, todayIdx) : lines.slice(0, 40);
        for (let i = 0; i < head.length; i++) {
          const l = head[i];
          if (!/^[\d,]{3,9}$/.test(l)) continue;
          const n = Number(l.replace(/,/g, ''));
          if (!Number.isFinite(n) || n < 100) continue;
          const prev = head[i - 1] || '';
          const next = head[i + 1] || '';
          // 数字可能在「升级」和「充值」之间，不要求紧挨「生效中」
          if (/升级|充值|生效中|下次续费|Starter|Free|订阅/.test(prev + ' ' + next) || /升级|充值|生效中|下次续费/.test(prev) || /升级|充值|生效中|下次续费/.test(next)) return n;
        }
        let bestComma = null;
        for (const l of head) {
          if (/^[\d,]{3,9}$/.test(l) && l.includes(',')) {
            const n = Number(l.replace(/,/g, ''));
            if (Number.isFinite(n) && n >= 100 && (bestComma == null || n > bestComma)) bestComma = n;
          }
        }
        if (bestComma != null) return bestComma;
        // 「升级」…数字…「充值」夹心（订阅卡常见，不要求紧挨生效中）
        {
          const upIdx = head.findIndex(l => l === '升级' || /^升级/.test(l));
          const payIdx = head.findIndex(l => l === '充值' || /^充值/.test(l));
          if (upIdx >= 0 && payIdx > upIdx) {
            let best = null;
            for (let i = upIdx + 1; i < payIdx; i++) {
              const l = head[i];
              if (!/^[\d,]{3,9}$/.test(l)) continue;
              const n = Number(l.replace(/,/g, ''));
              if (Number.isFinite(n) && n >= 100 && (best == null || n > best)) best = n;
            }
            if (best != null) return best;
          }
        }
        // head 里紧挨续费/升级/充值行的纯数字（无逗号的 2100）
        for (let i = 0; i < head.length; i++) {
          const l = head[i];
          if (!/^\d{3,7}$/.test(l)) continue;
          const n = Number(l);
          const prev = head[i - 1] || '';
          const next = head[i + 1] || '';
          if (/升级|充值|生效中|下次续费/.test(prev) || /升级|充值|生效中|下次续费/.test(next)) return n;
        }
        for (const line of lines) {
          if (/(?:本日|今日|本月)积分/.test(line)) continue;
          const m = line.match(/(?:账户)?积分(?:总额|总余额)[:：\s]*([\d,]+)/i) || line.match(/(?:可用|剩余)积分[:：\s]*([\d,]+)/i);
          if (m) {
            const n = Number(m[1].replace(/,/g, ''));
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
        return null;
      }
      const topbar = topbarLocal();
      const _pt = totalFromText(text);
      const _mu2 = modalUsableLocal();
      const pageTotal = [_pt, _mu2].filter(x => typeof x === 'number' && x > 0);
      const pageTotalMax = pageTotal.length ? Math.max(...pageTotal) : null;
      const compact = [];
      for (const el of document.querySelectorAll('div')) {
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (/Daily Login Bonus/i.test(t) && t.length < 180) compact.push(t);
      }
      return {
        emails: [...new Set(emails)], plan,
        todayBal: todayBal != null ? Number(String(todayBal).replace(/,/g, '')) : null,
        monthBal: monthBal != null ? Number(String(monthBal).replace(/,/g, '')) : null,
        pageTotal: pageTotalMax, modal_usable: _mu2,
        renewal, topbar_lightning: topbar,
        lines: lines.concat(compact),
        login: location.href.includes('/login'),
        err: /ERR_[A-Z_]{4,}|This site can.t be reached|无法访问此网站|198\.18\.\d+\.\d+/.test(text),
        hasDLB: /Daily Login Bonus/i.test(text),
      };
    });
    if (ledger.login) { out.status = 'login_required'; out.note = 'login'; console.log(JSON.stringify(out)); await browser.disconnect(); return; }
    if (ledger.err) { out.status = 'blocked'; out.note = 'connection error'; console.log(JSON.stringify(out)); await browser.disconnect(); return; }
    if (ledger.emails[0] && !out.email_seen) out.email_seen = ledger.emails[0];

    let parsed = parseBonus(ledger.lines);
    // 用量区已出现但今日行还没刷出来：再等一次重扫（早上到账抢跑）
    if (parsed.bonus == null && ledger.hasDLB) {
      await sleep(5000);
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, [role="tab"], div, span, a')) {
          if ((el.innerText || '').trim() === '用量') { el.click(); return; }
        }
      });
      await sleep(2000);
      const ledger2 = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const todayBal = (text.match(/(?:本日|今日)积分余额[:：\s]*([\d,]+)/) || [])[1];
        const monthBal = (text.match(/本月积分余额[:：\s]*([\d,]+)/) || [])[1];
        const compact = [];
        for (const el of document.querySelectorAll('div')) {
          const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
          if (/Daily Login Bonus/i.test(t) && t.length < 180) compact.push(t);
        }
        return {
          todayBal: todayBal != null ? Number(String(todayBal).replace(/,/g, '')) : null,
          monthBal: monthBal != null ? Number(String(monthBal).replace(/,/g, '')) : null,
          lines: lines.concat(compact),
          hasDLB: /Daily Login Bonus/i.test(text),
        };
      });
      const p2 = parseBonus(ledger2.lines);
      if (p2.bonus != null) parsed = p2;
      if (ledger.todayBal == null && ledger2.todayBal != null) ledger.todayBal = ledger2.todayBal;
      if (ledger.monthBal == null && ledger2.monthBal != null) ledger.monthBal = ledger2.monthBal;
      ledger.hasDLB = ledger.hasDLB || ledger2.hasDLB;
    }
    out.bonus = parsed.bonus;
    out.claimed_time = parsed.claimed_time;
    out.last_bonus = parsed.bonus == null ? parsed.last_bonus : null;
    out.plan = ledger.plan;
    out.renewal = ledger.renewal;
    out.today_remaining = ledger.todayBal != null ? ledger.todayBal : null;
    out.month_remaining = ledger.monthBal != null ? ledger.monthBal : null;
    // total_balance：API usablePower 权威；其次订阅/用量页；顶栏小数不得当总额
    const sub = subSnap || {};
    const topbarCands = [ledger.topbar_lightning, sub.topbar_lightning].filter(x => typeof x === 'number');
    out.topbar_lightning = topbarCands.length ? Math.max(...topbarCands) : null;
    const pageTotals = [sub.sub_total, ledger.pageTotal].filter(x => typeof x === 'number' && x > 0);
    let total = pageTotals.length ? Math.max(...pageTotals) : null;
    // 回退：本日+本月（仅无 API 时；有 usablePower 时不用，避免 used/周期上限加成假总额）
    if (total == null && out.usablePower == null && out.today_remaining != null && out.month_remaining != null) {
      const sum = out.today_remaining + out.month_remaining;
      if (sum > out.today_remaining && sum > (out.month_remaining || 0)) total = sum;
    }
    const tb = out.topbar_lightning;
    if (typeof tb === 'number' && tb > 0) {
      // 顶栏小数（<100 且 ≤ today_remaining）不得作为 total
      const looksLikeFraction = out.today_remaining != null && tb < 100 && tb <= out.today_remaining;
      const looksReal = !looksLikeFraction && (tb >= 100 || (out.today_remaining != null && tb > out.today_remaining));
      if (looksReal) {
        total = total == null ? tb : Math.max(total, tb);
      }
    }
    // API usablePower 覆盖页面启发式（真实可用总额）
    if (typeof out.usablePower === 'number' && out.usablePower >= 0) {
      total = out.usablePower;
      out.note_balance_source = 'api_usablePower';
    } else if (total != null && out.topbar_lightning === total) {
      out.note_balance_source = 'topbar';
    } else if (total != null) {
      out.note_balance_source = 'subscription_or_page';
    }
    out.total_balance = total;
    out.balance = out.total_balance != null ? out.total_balance : out.today_remaining;
    if (out.total_balance == null && out.today_remaining != null) {
      out.note_balance_fallback = 'today_remaining_only';
    }
    const apiNote = (typeof out.usablePower === 'number')
      ? `; api usable=${out.usablePower} used=${out.usedPower} totalPower=${out.totalPower} allocToday=${out.powerAllocatedToday}`
      : (out.api_account_error ? `; api_err=${out.api_account_error}` : '');
    // 每次成功扫号（ok/miss 只要进了用量页）都 dump 关键行
    try {
      const fs = require('fs');
      const dumpLines = (ledger.lines || []).filter(l => /Daily Login Bonus|每日登录|登录奖励|已获取|已消耗|积分余额|积分|[\d,]{2,}|2026-10-\d{2}/i.test(l)).slice(0, 120);
      const dumpPath = `/tmp/lovart-dlb-dump-${(expected||'unknown').replace(/[^a-zA-Z0-9@.]+/g,'_')}.json`;
      fs.writeFileSync(dumpPath, JSON.stringify({
        today: TODAY, email: expected,
        today_remaining: out.today_remaining,
        month_remaining: out.month_remaining,
        total_balance: out.total_balance,
        balance: out.balance,
        topbar_lightning: out.topbar_lightning,
        usablePower: out.usablePower,
        usedPower: out.usedPower,
        totalPower: out.totalPower,
        powerAllocatedToday: out.powerAllocatedToday,
        api_account_meta: out.api_account_meta || null,
        api_account_error: out.api_account_error || null,
        api_body_preview: (apiAccount && apiAccount.body) ? JSON.stringify(apiAccount.body).slice(0, 1500) : null,
        note_balance_source: out.note_balance_source || null,
        subSnap: sub,
        pageTotal: ledger.pageTotal,
        last: out.last_bonus,
        dumpLines,
        compactish: dumpLines.filter(l => /Daily Login Bonus|每日登录|登录奖励|积分余额/i.test(l)).slice(0, 30),
      }, null, 2));
      out.dlb_dump = dumpPath;
    } catch (_) {}
    if (out.bonus == null) {
      out.status = 'miss';
      out.note = `no today Daily Login Bonus; last=${out.last_bonus || 'unknown'}; plan=${out.plan}; 本日=${out.today_remaining}; 总额=${out.total_balance}; topbar=${out.topbar_lightning}; hasDLB=${ledger.hasDLB}` +
        (out.note_balance_fallback ? `; balFallback=${out.note_balance_fallback}` : '') +
        (out.note_balance_source ? `; balSrc=${out.note_balance_source}` : '') +
        apiNote;
    } else {
      out.status = 'ok';
      out.note = `Daily Login Bonus +${out.bonus} 已获取 ${out.claimed_time}; plan=${out.plan}; 本日=${out.today_remaining}; 总额=${out.total_balance}; topbar=${out.topbar_lightning}; renew=${out.renewal || ''}` +
        (out.switched_to_classic ? '; switched_new→classic' : '') +
        (out.note_balance_fallback ? `; balFallback=${out.note_balance_fallback}` : '') +
        (out.note_balance_source ? `; balSrc=${out.note_balance_source}` : '') +
        apiNote;
    }
    await page.keyboard.press('Escape').catch(() => {});
    console.log(JSON.stringify(out));
    await browser.disconnect();
  } catch (e) {
    out.status = 'blocked';
    out.note = String(e && e.message || e);
    console.log(JSON.stringify(out));
  }
})();
