import PDFDocument from "pdfkit";
import { columnsOf, group } from "./export.js";

const MARGIN = 36;
const HEADER_HEIGHT = 22;
const ROW_HEIGHT = 21;

// PDFKit's built-in Helvetica font uses WinAnsi. Normalize uncommon Unicode
// characters so a person's name cannot make an otherwise valid export fail.
function pdfText(value) {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
}

function columnWidths(columns, width) {
  const weights = columns.map((column) => {
    if (column.key === "date") return 0.95;
    if (column.key === "name") return 1.65;
    if (column.key === "department") return 1.35;
    if (column.key === "peopleId") return 1.1;
    if (["firstEntry", "lastEntry"].includes(column.key)) return 1.05;
    if (column.key === "duration") return 1;
    if (["cardNumber", "accessCount"].includes(column.key)) return 0.85;
    return Math.max(0.8, Math.min(1.8, (column.label || column.key).length / 8));
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => width * value / total);
}

/** Render a report PDF for the standalone Node server (Electron uses printToPDF). */
export function toPdf(report, rows, params, brandName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      info: { Title: report.title, Author: brandName },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const tableX = MARGIN;
    const tableWidth = pageWidth - MARGIN * 2;
    const cols = columnsOf(report, params);
    const widths = columnWidths(cols, tableWidth);
    const bottom = pageHeight - MARGIN;
    let y = MARGIN;

    const drawTableHeader = () => {
      doc.save().fillColor("#e2e8f0").rect(tableX, y, tableWidth, HEADER_HEIGHT).fill().restore();
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a");
      let x = tableX;
      cols.forEach((column, index) => {
        doc.text(pdfText(column.label), x + 5, y + 7, {
          width: Math.max(1, widths[index] - 10),
          height: 10,
          lineBreak: false,
          ellipsis: true,
        });
        x += widths[index];
      });
      y += HEADER_HEIGHT;
    };

    const drawContinuedPage = () => {
      doc.addPage();
      y = MARGIN;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a")
        .text(`${pdfText(report.title)} (continued)`, MARGIN, y);
      y += 20;
      drawTableHeader();
    };

    const ensureRoom = (height) => {
      if (y + height > bottom) drawContinuedPage();
    };

    doc.font("Helvetica-Bold").fontSize(17).fillColor("#0f172a")
      .text(pdfText(report.title), MARGIN, y);
    y += 24;
    doc.font("Helvetica").fontSize(9).fillColor("#64748b")
      .text(`${pdfText(report.subtitle(params))} · ${pdfText(brandName)} · Total ${rows.length}`, MARGIN, y);
    y += 23;
    drawTableHeader();

    let stripe = false;
    for (const section of group(report, rows)) {
      if (section.name !== null) {
        ensureRoom(ROW_HEIGHT);
        doc.save().fillColor("#f1f5f9").rect(tableX, y, tableWidth, ROW_HEIGHT).fill().restore();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#334155")
          .text(`${pdfText(section.name)} (${section.rows.length})`, tableX + 5, y + 7, {
            width: tableWidth - 10,
            height: 10,
            lineBreak: false,
            ellipsis: true,
          });
        y += ROW_HEIGHT;
      }

      for (const row of section.rows) {
        ensureRoom(ROW_HEIGHT);
        if (stripe) {
          doc.save().fillColor("#f8fafc").rect(tableX, y, tableWidth, ROW_HEIGHT).fill().restore();
        }
        doc.font("Helvetica").fontSize(8).fillColor("#1e293b");
        let x = tableX;
        cols.forEach((column, index) => {
          doc.text(pdfText(row[column.key]), x + 5, y + 7, {
            width: Math.max(1, widths[index] - 10),
            height: 10,
            lineBreak: false,
            ellipsis: true,
            align: column.align === "right" ? "right" : "left",
          });
          x += widths[index];
        });
        doc.save().strokeColor("#e2e8f0").moveTo(tableX, y + ROW_HEIGHT)
          .lineTo(tableX + tableWidth, y + ROW_HEIGHT).stroke().restore();
        y += ROW_HEIGHT;
        stripe = !stripe;
      }
    }

    ensureRoom(ROW_HEIGHT);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a")
      .text(`Total: ${rows.length}`, tableX + 5, y + 7);
    doc.end();
  });
}
