export function samplePdf(revision = false, padding = 0) {
  const page = (heading, detail) => [
    '0.05 0.37 0.33 rg 42 724 511 65 re f',
    '1 1 1 rg BT /F1 24 Tf 60 749 Td (' + heading + ') Tj ET',
    '0.10 0.18 0.25 rg BT /F1 14 Tf 48 685 Td (' + detail + ') Tj ET',
    'BT /F1 12 Tf 48 650 Td (This is a synthetic PDF for local PGS workflow testing.) Tj ET',
    'BT /F1 12 Tf 48 626 Td (There is no patient or clinical information in this file.) Tj ET',
  ].join('\n');
  const stream = data => '<< /Length ' + Buffer.byteLength(data) + ' >>\nstream\n' + data + '\nendstream';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(page('Patient Guide System', revision ? 'Synthetic outpatient guide - revised edition' : 'Synthetic outpatient guide - original edition')),
    stream(page('Document information', 'Page 2 of 2 / Local demonstration') + (padding ? '\n%' + 'X'.repeat(padding) + '\n' : '')),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 8\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(pdf + 'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}