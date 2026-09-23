// Intake in one step: keep only PDF attachments, drop ones already turned into a Bill,
// and build the Gemini request. An email with no PDF emits nothing, which ends the run here.
const GEMINI_MODEL = 'gemini-3.5-flash';

const SYSTEM_PROMPT = [
  'You extract structured data from vendor invoices (bills the user RECEIVES and must pay).',
  'The document may be a text PDF or a scanned/image-only PDF; read it visually if needed.',
  'Return STRICT JSON only, matching the response schema. No markdown, no commentary.',
  'Rules:',
  '- vendor_name is the party ISSUING the invoice (the supplier), not the customer being billed.',
  '- Use null for any field that is not printed on the invoice. NEVER guess or invent dates, amounts, emails or numbers.',
  '- Dates must be YYYY-MM-DD. If a date is ambiguous or absent, use null.',
  '- Amounts are plain numbers: no currency symbols or thousands separators.',
  '- One line_items entry per invoiced line. If there is no quantity column, use quantity 1.',
  '- subtotal is the pre-tax total, tax_amount the total tax, total_payable the final amount due.',
  '- payment_method is as stated on the invoice (e.g. "COD", "Bank transfer"), else null.',
].join('\n');

const nullable = (type) => ({ type, nullable: true });

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    vendor_name: nullable('STRING'),
    vendor_email: nullable('STRING'),
    invoice_number: nullable('STRING'),
    invoice_date: nullable('STRING'),
    due_date: nullable('STRING'),
    line_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          unit_price: { type: 'NUMBER' },
          total: { type: 'NUMBER' },
        },
        required: ['description', 'quantity', 'unit_price', 'total'],
      },
    },
    subtotal: nullable('NUMBER'),
    tax_amount: nullable('NUMBER'),
    total_payable: nullable('NUMBER'),
    payment_method: nullable('STRING'),
  },
  required: ['vendor_name', 'invoice_number', 'line_items', 'total_payable'],
};

// Dedupe layer 1: workflow static data persists across production runs (not manual test runs).
// Layer 2 is the "Check Existing Bill" lookup against Xero itself.
const store = $getWorkflowStaticData('global');
store.processed = store.processed || {};
const seen = new Set();

const isPdf = (b) => b.mimeType === 'application/pdf' || /\.pdf$/i.test(b.fileName || '');

const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const j = items[i].json;

  // Gmail items carry an `id`; items from the optional test Form Trigger do not.
  const isManual = !j.id;
  const messageId = isManual ? 'manual' : j.id;

  const internalMs = Number(j.internalDate);
  let received = internalMs ? new Date(internalMs) : new Date(j.date || Date.now());
  if (isNaN(received.getTime())) received = new Date();

  for (const [prop, bin] of Object.entries(items[i].binary || {})) {
    if (!isPdf(bin)) continue;

    const attachmentName = bin.fileName || 'invoice.pdf';
    // One key per attachment so an email with two invoices yields two bills.
    const dedupeKey = `${messageId}:${attachmentName}`;
    if (store.processed[dedupeKey] || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const buffer = await this.helpers.getBinaryDataBuffer(i, prop);

    out.push({
      json: {
        messageId,
        attachmentName,
        dedupeKey,
        subject: j.subject || (isManual ? 'Manual upload' : '(no subject)'),
        fromAddress: (j.from && j.from.value && j.from.value[0] && j.from.value[0].address) || '',
        receivedDate: received.toISOString().slice(0, 10),
        geminiModel: GEMINI_MODEL,
        geminiBody: {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: bin.mimeType || 'application/pdf', data: buffer.toString('base64') } },
                { text: 'Extract the invoice data as JSON.' },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        },
      },
    });
  }
}

return out;
