import 'server-only';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Campaign, calculateROI } from '../domain';
import { BRAND } from '../brand';
const ascii = (value: unknown) => String(value ?? '').replace(/[^\x20-\x7E]/g, ' ');
export async function makeExport(campaigns: Campaign[], format: 'pdf' | 'xlsx') {
  if (format === 'xlsx') {
    const book = new ExcelJS.Workbook();
    book.creator = BRAND.name;
    const sheet = book.addWorksheet('Campaign results');
    sheet.addRow([BRAND.name]);
    sheet.addRow([BRAND.tagline]);
    sheet.addRow([
      'Amounts in INR. Spend and ROI use configured estimated messaging rates, not Meta invoices.',
    ]);
    sheet.addRow([
      'Campaign ID',
      'Name',
      'Status',
      'Sent',
      'Delivered',
      'Read',
      'Failed',
      'Responses',
      'Bookings',
      'Confirmed',
      'Estimated spend (INR)',
      'Collected revenue (INR)',
      'Estimated ROI (%)',
    ]);
    for (const c of campaigns)
      sheet.addRow([
        c.id,
        c.name,
        c.status,
        c.sent,
        c.delivered,
        c.read,
        c.failed,
        c.responses,
        c.bookings,
        c.confirmed,
        c.spend / 100,
        c.revenue / 100,
        calculateROI(c.revenue, c.spend),
      ]);
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF137D79' } };
    sheet.columns.forEach((c) => (c.width = 22));
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    return Buffer.from(await book.xlsx.writeBuffer());
  }
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([842, 595]);
  let y = 550;
  const line = (text: string, size = 10, weight = false) => {
    if (y < 45) {
      page = doc.addPage([842, 595]);
      y = 550;
    }
    page.drawText(ascii(text), {
      x: 40,
      y,
      size,
      font: weight ? bold : font,
      color: rgb(0.08, 0.2, 0.3),
    });
    y -= size + 9;
  };
  line(BRAND.name, 22, true);
  line(BRAND.tagline, 11);
  line('WHATSAPP CAMPAIGN PERFORMANCE', 15, true);
  line(`Generated ${new Date().toISOString().slice(0, 10)} | All amounts in INR`);
  line(
    'Spend and ROI are estimates based on configured rates. Meta invoices are the source of actual cost.',
    9,
  );
  for (const c of campaigns) {
    y -= 10;
    line(`${c.id} - ${c.name}`, 12, true);
    line(
      `${c.status.toUpperCase()} | Sent: ${c.sent} | Delivered: ${c.delivered} | Read: ${c.read} | Failed: ${c.failed}`,
    );
    line(`Responses: ${c.responses} | Booking requests: ${c.bookings} | Confirmed: ${c.confirmed}`);
    line(
      `Estimated spend: ${(c.spend / 100).toFixed(2)} | Collected revenue: ${(c.revenue / 100).toFixed(2)} | Estimated ROI: ${calculateROI(c.revenue, c.spend) ?? 'N/A'}%`,
    );
  }
  return Buffer.from(await doc.save());
}
export async function makeReceipt(job: Record<string, unknown>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 780;
  const line = (s: string, size = 12, b = false) => {
    page.drawText(ascii(s), {
      x: 48,
      y,
      size,
      font: b ? bold : font,
      color: rgb(0.08, 0.24, 0.36),
    });
    y -= size + 16;
  };
  line(BRAND.name, 24, true);
  line(BRAND.tagline, 12);
  y -= 20;
  line('PATIENT JOB CARD / PAYMENT RECEIPT', 15, true);
  line(`Job: ${job.id} | Created: ${String(job.createdAt).slice(0, 10)}`);
  line(`Patient: ${job.customerName}`);
  line(`Campaign: ${job.campaignId} | Offer: ${job.offerId}`);
  line(`Tests / packages: ${(job.testIds as string[]).join(', ')}`);
  y -= 24;
  for (const [label, value] of [
    ['Original price', job.originalPrice],
    ['Discount', job.discount],
    ['Total', job.total],
    ['Amount paid', job.paid],
    ['Balance', Number(job.total) - Number(job.paid)],
  ])
    line(`${label}: INR ${(Number(value) / 100).toFixed(2)}`, 14, label === 'Total');
  y -= 24;
  line('Thank you for choosing Baunthiyal Path Lab.', 11);
  line('This receipt reflects payments recorded by authorized staff.', 9);
  return Buffer.from(await doc.save());
}
