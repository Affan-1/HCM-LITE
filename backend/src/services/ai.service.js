const { query } = require('../config/db');
const { getTodayDateString } = require('./attendance.service');
const { getEmployeeLeaveBalances } = require('./leave.service');

let _geminiClient = null;
function getGeminiClient() {
  if (_geminiClient) return _geminiClient;
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(key);
    _geminiClient = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    return _geminiClient;
  } catch (e) {
    console.error('[AI] Failed to load @google/generative-ai:', e.message);
    return null;
  }
}

const TOOLS = {
  get_headcount: ({ department_id } = {}) => {
    let sql = "SELECT COUNT(*) as count FROM employees WHERE employment_status IN ('active', 'probation')";
    const params = [];
    if (department_id) {
      sql += " AND department_id = ?";
      params.push(department_id);
    }
    const res = query.get(sql, params);
    return { active_headcount: res.count };
  },

  get_attendance_summary: ({ date, department_id } = {}) => {
    const targetDate = date || getTodayDateString();
    let sql = `
      SELECT status, COUNT(*) as count
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE a.attendance_date = ?
    `;
    const params = [targetDate];
    if (department_id) {
      sql += " AND e.department_id = ?";
      params.push(department_id);
    }
    sql += " GROUP BY status";
    const rows = query.all(sql, params);

    const summary = { date: targetDate, present: 0, late: 0, half_day: 0, on_leave: 0 };
    rows.forEach(r => {
      if (r.status === 'present') summary.present += r.count;
      if (r.status === 'late') {
        summary.present += r.count;
        summary.late += r.count;
      }
      if (r.status === 'half_day') summary.half_day += r.count;
    });

    const leavesCount = query.get(`
      SELECT COUNT(DISTINCT employee_id) as count
      FROM leave_requests
      WHERE status = 'approved' AND ? BETWEEN start_date AND end_date
    `, [targetDate]).count;
    summary.on_leave = leavesCount;

    return summary;
  },

  get_late_comers: ({ month, limit = 5 } = {}) => {
    const targetMonth = month || getTodayDateString().substring(0, 7);
    const rows = query.all(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, d.name as department_name, COUNT(a.id) as late_count
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      WHERE a.status = 'late' AND a.attendance_date LIKE ?
      GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name
      ORDER BY late_count DESC
      LIMIT ?
    `, [`${targetMonth}%`, limit]);
    return { month: targetMonth, late_comers: rows };
  },

  get_leave_summary: ({ date, department_id } = {}) => {
    const targetDate = date || getTodayDateString();
    let sql = `
      SELECT lr.id, e.first_name, e.last_name, lt.name as leave_type, lr.start_date, lr.end_date, lr.reason
      FROM leave_requests lr
      JOIN employees e ON lr.employee_id = e.id
      JOIN leave_types lt ON lr.leave_type_id = lt.id
      WHERE lr.status = 'approved' AND ? BETWEEN lr.start_date AND lr.end_date
    `;
    const params = [targetDate];
    if (department_id) {
      sql += " AND e.department_id = ?";
      params.push(department_id);
    }
    const employeesOnLeave = query.all(sql, params);
    return {
      date: targetDate,
      total_on_leave: employeesOnLeave.length,
      employees: employeesOnLeave
    };
  },

  get_my_leave_balance: (params, user) => {
    if (!user || !user.employee_id) {
      return { error: 'No employee record linked to current user.' };
    }
    const balances = getEmployeeLeaveBalances(user.employee_id);
    return { leave_balances: balances };
  },

  get_payroll_summary: ({ year_month } = {}, user) => {
    if (user.role === 'employee') {
      return { error: 'Access denied: Employees cannot view organizational payroll summaries.' };
    }
    const month = year_month || getTodayDateString().substring(0, 7);
    const run = query.get('SELECT * FROM payroll_runs WHERE year_month = ?', [month]) ||
                query.get('SELECT * FROM payroll_runs ORDER BY year_month DESC LIMIT 1');
    return { payroll_summary: run || 'No payroll runs recorded yet.' };
  },

  search_employees: ({ query: searchQ } = {}, user) => {
    let sql = `
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.phone,
             d.name as department_name, des.title as designation_title
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE (e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ? OR e.employee_code LIKE ?)
    `;
    const term = `%${searchQ}%`;
    const params = [term, term, term, term];
    const results = query.all(sql, params);
    return { matches: results };
  }
};

// ─── Gather live HCM context for Gemini system prompt ─────────────────────────
function buildHcmContext(user) {
  try {
    const today = getTodayDateString();

    // Headcount
    const hc = query.get("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('active','probation')");

    // Today's attendance
    const attRows = query.all(
      "SELECT status, COUNT(*) as c FROM attendance WHERE attendance_date=? GROUP BY status", [today]
    );
    const att = { present: 0, late: 0, half_day: 0 };
    attRows.forEach(r => {
      if (r.status === 'present') att.present += r.c;
      if (r.status === 'late') { att.present += r.c; att.late += r.c; }
      if (r.status === 'half_day') att.half_day += r.c;
    });

    // On leave today
    const onLeave = query.get(
      "SELECT COUNT(DISTINCT employee_id) as c FROM leave_requests WHERE status='approved' AND ? BETWEEN start_date AND end_date", [today]
    );

    // Pending leave approvals
    const pending = query.get("SELECT COUNT(*) as c FROM leave_requests WHERE status='pending'");

    // Departments
    const depts = query.all("SELECT name FROM departments ORDER BY name").map(d => d.name).join(', ');

    // User's own leave balances (if employee)
    let myLeave = '';
    if (user.employee_id) {
      try {
        const bal = getEmployeeLeaveBalances(user.employee_id);
        myLeave = bal.map(b => `${b.name}: ${b.remaining}/${b.yearly_quota} remaining`).join(', ');
      } catch (_) {}
    }

    // Company settings
    const settings = query.get("SELECT company_name, office_start_time, grace_period_minutes, working_hours_per_day FROM settings LIMIT 1") || {};

    return {
      today,
      company_name: settings.company_name || 'the company',
      office_start: settings.office_start_time || '09:00',
      grace_period: settings.grace_period_minutes || 15,
      working_hours: settings.working_hours_per_day || 8,
      headcount: hc?.c ?? 0,
      present_today: att.present,
      late_today: att.late,
      half_day_today: att.half_day,
      on_leave_today: onLeave?.c ?? 0,
      pending_leave_approvals: pending?.c ?? 0,
      departments: depts || 'N/A',
      my_leave_balances: myLeave || null,
    };
  } catch (e) {
    return {};
  }
}

function buildSystemPrompt(user, ctx) {
  const roleDesc = user.role === 'admin'
    ? 'System Administrator with full access to all organizational data.'
    : user.role === 'hr'
    ? 'HR Manager with access to employee, attendance, leave, and payroll data.'
    : 'Employee with access only to their own personal data.';

  return `You are HCM Lite AI Assistant — an intelligent HR and workforce management assistant for ${ctx.company_name}.

## Current User
- Name: ${user.name || 'User'}
- Role: ${user.role} (${roleDesc})
- Today's Date: ${ctx.today}

## Live HCM Snapshot (as of right now)
- Active Headcount: ${ctx.headcount} employees
- Today's Attendance: ${ctx.present_today} present, ${ctx.late_today} late arrivals, ${ctx.half_day_today} half days, ${ctx.on_leave_today} on approved leave
- Pending Leave Approvals: ${ctx.pending_leave_approvals}
- Departments: ${ctx.departments}
${ctx.my_leave_balances ? `- ${user.name || 'Your'} Leave Balances: ${ctx.my_leave_balances}` : ''}

## Company Policies
- Office Hours: ${ctx.office_start} with ${ctx.grace_period}-minute grace period
- Late threshold: arrivals after ${ctx.office_start} + ${ctx.grace_period} min are marked late
- Working hours per day: ${ctx.working_hours} hours; under 5h = half day
- Standard yearly leave quotas: 14 Annual, 8 Sick, 10 Casual, Unlimited Unpaid
- Tax slabs (annual income): ≤600k → 0%, 600k–1.2M → 5% on excess, 1.2M–2.4M → 30k+15%, 2.4M–3.6M → 210k+25%, >3.6M → 510k+35%

## Privacy Rules (strictly enforce)
- NEVER disclose another employee's salary to employees.
- NEVER reveal another employee's personal contact or medical data to employees.
- Admins and HR may access aggregate payroll and workforce data.

## Instructions
- Answer any question about HR, attendance, leave, payroll, company policies, workforce management, or general knowledge.
- Use the live HCM snapshot data above when answering data-related questions.
- If a question is outside your HCM/HR context but is general knowledge (e.g., "what is an OKR?"), answer helpfully.
- Keep responses concise, professional, and formatted in plain text (use bullet points if listing items).
- If you don't have enough data to answer precisely, say what you know and suggest what the user can do (e.g., check the attendance board, run a payroll).
- Never fabricate specific names or numbers beyond what is in the snapshot. If details are unavailable, say so honestly.`;
}

/**
 * Handle AI Assistant queries — Gemini-powered with smart HCM fallback
 */
async function processAiChat(prompt, user) {
  const pLower = prompt.toLowerCase();
  const toolCalls = [];
  let responseText = '';

  // ── Try Gemini AI first ────────────────────────────────────────────────────
  const gemini = getGeminiClient();
  if (gemini) {
    try {
      const ctx = buildHcmContext(user);
      const systemPrompt = buildSystemPrompt(user, ctx);

      // Gather additional tool data relevant to the query
      const extraData = {};
      if (pLower.includes('leave') || pLower.includes('chutti')) {
        if (user.employee_id) {
          toolCalls.push({ tool: 'get_my_leave_balance', args: {} });
          extraData.my_leave_balances = TOOLS.get_my_leave_balance({}, user);
        }
        toolCalls.push({ tool: 'get_leave_summary', args: { date: getTodayDateString() } });
        extraData.leave_summary = TOOLS.get_leave_summary({ date: getTodayDateString() });
      }
      if (pLower.includes('late') || pLower.includes('attendance') || pLower.includes('hazir')) {
        toolCalls.push({ tool: 'get_attendance_summary', args: {} });
        extraData.attendance_summary = TOOLS.get_attendance_summary({});
        toolCalls.push({ tool: 'get_late_comers', args: { limit: 5 } });
        extraData.late_comers = TOOLS.get_late_comers({ limit: 5 });
      }
      if (pLower.includes('headcount') || pLower.includes('employee') || pLower.includes('staff')) {
        toolCalls.push({ tool: 'get_headcount', args: {} });
        extraData.headcount = TOOLS.get_headcount({});
      }
      if ((pLower.includes('payroll') || pLower.includes('salary') || pLower.includes('pay')) && user.role !== 'employee') {
        toolCalls.push({ tool: 'get_payroll_summary', args: {} });
        extraData.payroll_summary = TOOLS.get_payroll_summary({}, user);
      }

      const fullPrompt = Object.keys(extraData).length > 0
        ? `${prompt}\n\n[Additional live data fetched for this query:]\n${JSON.stringify(extraData, null, 2)}`
        : prompt;

      const result = await gemini.generateContent([
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'Understood. I am the HCM Lite AI Assistant, ready to help.' }] },
        { role: 'user', parts: [{ text: fullPrompt }] }
      ]);

      responseText = result.response.text();
      logAiCall(user, prompt, responseText, toolCalls);
      return { response: responseText, tool_calls: toolCalls, is_ai_generated: true, powered_by: 'gemini' };
    } catch (err) {
      console.error('[AI] Gemini error:', err.message);
      // Fall through to keyword fallback
    }
  }

  // ── Keyword-matching fallback (no API key or Gemini error) ─────────────────
  if (
    (pLower.includes('salary') || pLower.includes('pay') || pLower.includes('tankhwah')) &&
    user.role === 'employee'
  ) {
    responseText = "I cannot disclose salary or personal compensation information of other colleagues due to privacy and security policies.";
  }
  else if (
    pLower.includes('leave balance') || pLower.includes('my leave') ||
    pLower.includes('sick leave') || pLower.includes('chutti bachi')
  ) {
    if (user.employee_id) {
      toolCalls.push({ tool: 'get_my_leave_balance', args: {} });
      const data = TOOLS.get_my_leave_balance({}, user);
      const sick   = data.leave_balances?.find(b => b.code === 'sick');
      const annual = data.leave_balances?.find(b => b.code === 'annual');
      const casual = data.leave_balances?.find(b => b.code === 'casual');
      responseText = `You have ${sick?.remaining ?? 0} sick, ${casual?.remaining ?? 0} casual, and ${annual?.remaining ?? 0} annual leaves remaining this year.`;
    } else {
      responseText = "Your admin account is not linked to an employee record.";
    }
  }
  else if (pLower.includes('who is on leave') || pLower.includes('on leave today')) {
    toolCalls.push({ tool: 'get_leave_summary', args: { date: getTodayDateString() } });
    const data = TOOLS.get_leave_summary({ date: getTodayDateString() });
    responseText = data.total_on_leave === 0
      ? "No employees are on approved leave today."
      : `${data.total_on_leave} employee(s) on leave today: ${data.employees.map(e => `${e.first_name} ${e.last_name}`).join(', ')}.`;
  }
  else if (pLower.includes('headcount') || pLower.includes('active employees') || pLower.includes('how many employees')) {
    toolCalls.push({ tool: 'get_headcount', args: {} });
    const data = TOOLS.get_headcount({});
    responseText = `Active headcount: ${data.active_headcount} employees.`;
  }
  else if (pLower.includes('late') && (pLower.includes('who') || pLower.includes('most'))) {
    toolCalls.push({ tool: 'get_late_comers', args: { limit: 5 } });
    const data = TOOLS.get_late_comers({ limit: 5 });
    responseText = data.late_comers.length === 0
      ? "No late arrivals recorded this month."
      : `Top late-comers: ${data.late_comers.map(l => `${l.first_name} ${l.last_name} (${l.late_count}x)`).join(', ')}.`;
  }
  else if (pLower.includes('attendance')) {
    toolCalls.push({ tool: 'get_attendance_summary', args: {} });
    const data = TOOLS.get_attendance_summary({});
    responseText = `Today: ${data.present} present, ${data.late} late, ${data.on_leave} on leave.`;
  }
  else if (pLower.includes('office hour') || pLower.includes('grace period') || pLower.includes('start time')) {
    responseText = "Office hours start at 09:00 AM with a 15-minute grace period. Under 5 hours is a half day.";
  }
  else if (pLower.includes('leave quota') || pLower.includes('leave policy') || pLower.includes('annual leave')) {
    responseText = "Yearly quotas: 14 Annual, 8 Sick, 10 Casual, Unlimited Unpaid (weekends and holidays excluded).";
  }
  else if (pLower.includes('tax')) {
    responseText = "Tax slabs: ≤600k=0%, 600k–1.2M=5%, 1.2M–2.4M=30k+15%, 2.4M–3.6M=210k+25%, >3.6M=510k+35%.";
  }
  else {
    const isKeyMissing = !process.env.AI_API_KEY;
    responseText = isKeyMissing
      ? `I'm running in limited mode (no AI_API_KEY set). I can still answer:\n• "Who is on leave today?"\n• "How many active employees?"\n• "Show attendance summary"\n• "My leave balance"\n• Leave quota / tax slab / office hours policy\n\nFor full AI capabilities, add your free Gemini API key: set AI_API_KEY in backend/.env (get one free at aistudio.google.com).`
      : `I couldn't process that request. Try asking:\n• "Who is on leave today?"\n• "Show me the attendance summary"\n• "What is my leave balance?"\n• "Who came late most often this month?"`;
  }

  logAiCall(user, prompt, responseText, toolCalls);
  return { response: responseText, tool_calls: toolCalls, is_ai_generated: true, powered_by: 'fallback' };
}

function logAiCall(user, prompt, response, toolCalls) {
  try {
    query.run(`
      INSERT INTO ai_logs (user_id, user_role, prompt, response, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, [
      user?.id || null,
      user?.role || 'anonymous',
      prompt,
      response,
      JSON.stringify(toolCalls || [])
    ]);
  } catch (e) {
    console.error('Failed to log AI call:', e);
  }
}

/**
 * Smart leave parsing from natural language
 */
function parseSmartLeave(text) {
  const t = text.toLowerCase();
  const now = new Date();

  // Helper to format Date to YYYY-MM-DD
  const formatDate = d => d.toISOString().split('T')[0];

  let type = 'casual';
  if (t.includes('sick') || t.includes('fever') || t.includes('tabiyat') || t.includes('doctor') || t.includes('hospital') || t.includes('bimar')) {
    type = 'sick';
  } else if (t.includes('annual') || t.includes('vacation') || t.includes('holiday')) {
    type = 'annual';
  } else if (t.includes('unpaid')) {
    type = 'unpaid';
  }

  let startDate = new Date();
  let endDate = new Date();

  if (t.includes('tomorrow') || t.includes('kal')) {
    startDate.setDate(now.getDate() + 1);
    endDate = new Date(startDate);
    if (t.includes('two days') || t.includes('2 days') || t.includes('parso') || t.includes('do din')) {
      endDate.setDate(startDate.getDate() + 1);
    }
  } else if (t.includes('next monday') || t.includes('aglay peer')) {
    // find next monday
    const day = now.getDay();
    const daysUntilNextMon = ((1 + 7 - day) % 7) || 7;
    startDate.setDate(now.getDate() + daysUntilNextMon);
    endDate = new Date(startDate);
    if (t.includes('tuesday') || t.includes('2 days') || t.includes('do din')) {
      endDate.setDate(startDate.getDate() + 1);
    }
  } else if (t.includes('today') || t.includes('aaj')) {
    startDate = new Date(now);
    endDate = new Date(now);
    if (t.includes('tomorrow') || t.includes('2 days')) {
      endDate.setDate(startDate.getDate() + 1);
    }
  } else {
    // Default to next working day
    startDate.setDate(now.getDate() + 1);
    endDate = new Date(startDate);
  }

  // Find matching leave_type_id
  const lt = query.get('SELECT id FROM leave_types WHERE code = ?', [type]) ||
             query.get('SELECT id FROM leave_types WHERE code = ?', ['casual']);

  return {
    leave_type_id: lt?.id || 1,
    type,
    start_date: formatDate(startDate),
    end_date: formatDate(endDate),
    reason: text
  };
}

/**
 * Generate 3-5 concise bullet insights from KPI numbers
 */
function summarizeDashboardKpis(kpiData, role = 'admin') {
  const bullets = [];

  if (role === 'admin' || role === 'hr') {
    if (kpiData.headcount !== undefined) {
      bullets.push(`Total active workforce stands at **${kpiData.headcount} employees**.`);
    }
    if (kpiData.attrition_ytd !== undefined) {
      bullets.push(`Year-to-date attrition rate is currently maintained at **${kpiData.attrition_ytd}%**.`);
    }
    if (kpiData.payroll_cost !== undefined) {
      bullets.push(`Latest monthly payroll expenditure sums to **PKR ${Number(kpiData.payroll_cost).toLocaleString()}**.`);
    }
    if (kpiData.present_today !== undefined) {
      bullets.push(`Today's physical attendance logged **${kpiData.present_today} members present** with **${kpiData.late_today || 0} late arrivals**.`);
    }
    if (kpiData.pending_approvals > 0) {
      bullets.push(`Action required: **${kpiData.pending_approvals} pending approval requests** await review in the HR inbox.`);
    }
  }

  if (bullets.length === 0) {
    bullets.push('All department operations and attendance metrics are within established standard thresholds.');
    bullets.push('Payroll and leave balances are fully aligned with monthly organizational policies.');
    bullets.push('No critical anomalies or policy deviations reported for the current cycle.');
  }

  return bullets;
}

module.exports = {
  processAiChat,
  parseSmartLeave,
  summarizeDashboardKpis
};
