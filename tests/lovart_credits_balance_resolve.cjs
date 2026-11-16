#!/usr/bin/env node
/**
 * FAKE DATA / 假数据。checker 余额纯函数回归，不启动浏览器、不访问网络。
 */
const fs = require('fs');
const path = require('path');
const {
  resolveCheckerBalance,
  renewalDayPoisonFromText,
  looksRealTopbar,
  emailLocalPoisonNumbers,
} = require('../lovart-auto/check-one.cjs');

const cases = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/lovart-credits/balance-cases.json'), 'utf8'
)).cases;

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('PASS', name);
  } else {
    failed += 1;
    console.error('FAIL', name, detail || '');
  }
}

for (const c of cases) {
  const got = resolveCheckerBalance(c.ctx);
  check(
    'node ' + c.id,
    got.total_balance === c.expect_total && got.balance === c.expect_total,
    JSON.stringify({ total: got.total_balance, balance: got.balance, why: got.note_balance_unreliable })
  );
  if (c.expect_total == null) {
    check(c.id + ' balance_not_today', got.balance == null, String(got.balance));
  }
}

check(
  'renewal day 13 poisoned',
  renewalDayPoisonFromText('下次续费 2099-03-13').has(13),
  ''
);
check(
  'fraction 29/100 not real',
  looksRealTopbar(29, 100) === false,
  ''
);
check(
  'topbar 2100 still real',
  looksRealTopbar(2100, 70) === true,
  ''
);
check(
  'pure local email poison',
  emailLocalPoisonNumbers('123456789@example.com').has(123456789),
  ''
);
check(
  'short acct label is not poison',
  emailLocalPoisonNumbers('acct101@example.com').has(101) === false,
  ''
);

const sum = resolveCheckerBalance({
  email: 'acct102@example.com',
  todayRemaining: 70,
  monthRemaining: 30,
  topbar: null,
  pageTotal: null,
  usablePower: null,
  apiLoggedIn: false,
  noLogin: false,
});
check('today_plus_month_when_not_no_login', sum.total_balance === 100, JSON.stringify(sum));

const blocked = resolveCheckerBalance({
  email: 'acct102@example.com',
  todayRemaining: 70,
  monthRemaining: 30,
  topbar: 2100,
  pageTotal: 2100,
  usablePower: null,
  apiLoggedIn: false,
  apiError: 'No login',
  noLogin: true,
});
check('no_login_blocks_page_and_sum', blocked.total_balance == null && blocked.balance == null, JSON.stringify(blocked));

if (failed) {
  console.error('node balance checks failed:', failed);
  process.exit(1);
}
console.log('node balance checks ok');
