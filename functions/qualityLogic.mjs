// Pure quality-report domain logic. No Google APIs, side effects or secrets.
export const ISSUE_TYPES = ['הקצפת יתר', 'טעם חריג', 'ריח חריג', 'בעיה באריזה', 'משקעים / עכירות', 'אחר'];
export const PACKAGES = ['חבית', 'בקבוק', 'פחית', 'אחר', 'לא ידוע'];
export const BEER_TYPES = ['IPA', 'פייל אייל', 'לאגר', 'הופי לאגר', 'חיטה', 'סטאוט'];
export const HEADERS = [
  'מספר אירוע', 'סוג התקלה', 'טלפון המדווח', 'סוג האריזה', 'מק"ט',
  'קישורים למדיה', 'מזהה שליחה', 'תאריך ושעת דיווח', 'סטטוס התראה', 'מקור הדיווח',
];
export function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\u200e\u200f]/g, '').replace(/[\s"'׳״.,\-_/\\]+/g, ' ');
}
export function required(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error('יש למלא ' + label + ' (עד ' + max + ' תווים).');
  }
  return value.trim();
}
export function optional(value, max, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) throw new Error('ערך לא תקין עבור ' + label);
  return value.trim();
}
export function validateReport(data) {
  const customer = required(data.customer, 120, 'שם לקוח');
  const beer = required(data.beer, 80, 'סוג בירה');
  const type = required(data.issueType, 40, 'סוג התקלה');
  if (!ISSUE_TYPES.includes(type)) throw new Error('סוג תקלה לא מוכר.');
  const packageType = optional(data.packageType, 40, 'סוג האריזה') || 'לא ידוע';
  if (!PACKAGES.includes(packageType)) throw new Error('סוג אריזה לא מוכר.');
  const reporter = required(data.reporter, 120, 'שם המדווח');
  const description = required(data.description, 2000, 'תיאור התקלה');
  const quantity = optional(data.quantity, 120, 'כמות');
  const batch = optional(data.batch, 50, 'מספר אצווה');
  const expiry = optional(data.expiry, 10, 'תאריך תפוגה');
  if (expiry && !validIsoDate(expiry)) throw new Error('תאריך תפוגה לא תקין.');
  const phone = optional(data.phone, 30, 'טלפון');
  if (phone && !/^[+0-9()\s-]{6,30}$/.test(phone)) throw new Error('מספר טלפון לא תקין.');
  const sku = packageType === 'לא ידוע' ? '' : normalize(beer) + ' / ' + packageType;
  return {customer, beer, type, packageType, reporter, description, quantity, batch, expiry, phone, sku};
}
function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === value;
}
export function formatIsraeliDate(date) {
  return new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Jerusalem',day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
}
export function parseSheetDate(raw) {
  const value = String(raw || '').trim();
  const d = value.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/);
  if (!d) return null;
  const year = d[3] ? (d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3])) : new Date().getFullYear();
  const dt = new Date(Date.UTC(year, Number(d[2])-1, Number(d[1]),12));
  if (dt.getUTCDate() !== Number(d[1]) || dt.getUTCMonth() !== Number(d[2])-1) return null;
  return dt;
}
export function inferIssueType(description) {
  const value = normalize(description);
  if (/מקציפ|קצף|גאשינג|גשינג/.test(value)) return 'הקצפת יתר';
  if (/טעם/.test(value)) return 'טעם חריג';
  if (/ריח/.test(value)) return 'ריח חריג';
  if (/משקע|עכור/.test(value)) return 'משקעים / עכירות';
  if (/פקק|אריז|נזיל|תווית/.test(value)) return 'בעיה באריזה';
  return 'אחר';
}
export function inferPackageType(quantity) {
  const v = normalize(quantity);
  if (/חבי|חבית|קג|keg/.test(v)) return 'חבית';
  if (/בקבוק|ארגז/.test(v)) return 'בקבוק';
  if (/פחית/.test(v)) return 'פחית';
  return 'לא ידוע';
}
export function rowsToReports(rows) {
  // The original sheet keeps its existing A:T columns; extra metadata is U:AD.
  return rows.map((r,i) => ({
    ticket: String(r[0] || '').trim(),
    customer: String(r[2] || '').trim(),
    beer: String(r[3] || '').trim(),
    batch: String(r[4] || '').trim(),
    quantity: String(r[6] || ''),
    date: parseSheetDate(r[7]),
    description: String(r[9] || ''),
    eventId: String(r[20] || ('LEGACY-' + String(r[0] || i+5))),
    type: String(r[21] || inferIssueType(r[9])),
    packageType: String(r[23] || inferPackageType(r[6])),
    sku: String(r[24] || ''),
    rowIndex: i + 5,
  })).filter(r => r.ticket && r.customer && r.beer);
}
export function relatedEvent(reports, report, now, days=90) {
  if (!report.batch) return null; // A missing batch must never auto-merge unrelated incidents.
  const since = now.valueOf() - days * 86400_000;
  return [...reports].reverse().find(r =>
    r.date && r.date.valueOf() >= since &&
    normalize(r.customer) === normalize(report.customer) &&
    normalize(r.beer) === normalize(report.beer) &&
    normalize(r.batch) === normalize(report.batch) &&
    r.type === report.type
  ) || null;
}
export function distinctSkuEvents(reports, report, now, days=90) {
  if (!report.sku) return new Set();
  const since = now.valueOf() - days * 86400_000;
  return new Set(reports.filter(r => {
    if (!r.date || r.date.valueOf() < since) return false;
    const sku = r.sku || (r.packageType === 'לא ידוע' ? '' : normalize(r.beer) + ' / ' + r.packageType);
    return normalize(sku) === normalize(report.sku);
  }).map(r => r.eventId));
}
export function createSheetRow(ticket, eventId, report, mediaUrls, timestamp, submissionId, alertStatus='') {
  const row = new Array(30).fill('');
  row[0] = ticket; row[2] = report.customer; row[3] = report.beer; row[4] = report.batch;
  row[5] = report.expiry ? formatIsraeliDate(new Date(report.expiry + 'T12:00:00Z')) : '';
  row[6] = report.quantity; row[7] = formatIsraeliDate(timestamp);
  row[8] = report.reporter; row[9] = report.description;
  row[20] = eventId; row[21] = report.type; row[22] = report.phone;
  row[23] = report.packageType; row[24] = report.sku;
  row[25] = mediaUrls.join('\n'); row[26] = submissionId;
  row[27] = timestamp.toISOString(); row[28] = alertStatus; row[29] = 'טופס אינטרנטי';
  return row;
}
