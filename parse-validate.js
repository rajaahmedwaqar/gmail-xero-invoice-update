// Parse the Gemini response, validate it (plan step 4) and work out fallback dates.
const TOLERANCE = 1.0;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const validDate = (v) => {
  const s = toStr(v);
  if (!s || !ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

// Models occasionally wrap JSON in fences despite instructions: strip them defensively.
const parseModelJson = (text) => {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch (err) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw err;
  }
};

const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const resp = items[i].json;
  const { geminiBody, ...meta } = $('Prepare Invoices').itemMatching(i).json;

  const notes = [];
  const fallbacks = [];
  let extracted = null;
  let rawText = '';

  const candidate = resp.candidates && resp.candidates[0];
  rawText = ((candidate && candidate.content && candidate.content.parts) || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');

  if (resp.promptFeedback && resp.promptFeedback.blockReason) {
    notes.push(`Gemini blocked the request: ${resp.promptFeedback.blockReason}`);
  }
  if (candidate && candidate.finishReason && !['STOP', undefined].includes(candidate.finishReason)) {
    notes.push(`Gemini finishReason was ${candidate.finishReason} (output may be truncated)`);
  }

  if (!rawText) {
    notes.push('Gemini returned no text');
  } else {
    try {
      const p = parseModelJson(rawText);
      extracted = {
        vendor_name: toStr(p.vendor_name),
        vendor_email: toStr(p.vendor_email),
        invoice_number: toStr(p.invoice_number),
        invoice_date: toStr(p.invoice_date),
        due_date: toStr(p.due_date),
        line_items: Array.isArray(p.line_items)
          ? p.line_items.map((li) => ({
              description: toStr(li.description),
              quantity: toNum(li.quantity),
              unit_price: toNum(li.unit_price),
              total: toNum(li.total),
            }))
          : [],
        subtotal: toNum(p.subtotal),
        tax_amount: toNum(p.tax_amount),
        total_payable: toNum(p.total_payable),
        payment_method: toStr(p.payment_method),
      };
    } catch (err) {
      notes.push(`AI response was not valid JSON: ${err.message}`);
    }
  }

  let billDate = null;
  let billDueDate = null;

  if (extracted) {
    if (!extracted.vendor_name) notes.push('vendor_name is missing');
    if (!extracted.invoice_number) notes.push('invoice_number is missing');
    if (extracted.total_payable === null) notes.push('total_payable is missing or not a number');
    if (extracted.line_items.length === 0) {
      notes.push('line_items is empty');
    }
    extracted.line_items.forEach((li, n) => {
      if (li.quantity === null || li.unit_price === null) {
        notes.push(`line_items[${n}] ("${li.description || ''}") is missing quantity or unit_price`);
      }
    });

    const { subtotal, tax_amount, total_payable } = extracted;
    if (subtotal !== null && tax_amount !== null && total_payable !== null) {
      const diff = Math.abs(subtotal + tax_amount - total_payable);
      if (diff > TOLERANCE) {
        notes.push(
          `subtotal (${subtotal}) + tax (${tax_amount}) = ${(subtotal + tax_amount).toFixed(2)} ` +
            `does not match total_payable (${total_payable}); difference ${diff.toFixed(2)}`
        );
      }
    }

    // Fallback dates: invoice date -> email received date; due date -> invoice date (e.g. COD).
    const invDate = validDate(extracted.invoice_date);
    if (extracted.invoice_date && !invDate) {
      fallbacks.push(`invoice_date "${extracted.invoice_date}" was not a valid YYYY-MM-DD date`);
    }
    billDate = invDate || meta.receivedDate;
    if (!invDate) {
      fallbacks.push(`Invoice date not on invoice: used the email received date (${billDate})`);
    }

    const dueDate = validDate(extracted.due_date);
    if (extracted.due_date && !dueDate) {
      fallbacks.push(`due_date "${extracted.due_date}" was not a valid YYYY-MM-DD date`);
    }
    billDueDate = dueDate || billDate;
    if (!dueDate) {
      const cod = /\b(cod|cash on delivery)\b/i.test(extracted.payment_method || '');
      fallbacks.push(
        `Due date not on invoice: set to the bill date (${billDueDate})${cod ? ' - payment method is COD' : ''}`
      );
    }
  }

  out.push({
    json: {
      ...meta,
      extracted,
      raw_text: rawText,
      billDate,
      billDueDate,
      fallbacks,
      valid: notes.length === 0,
      validation_notes: notes,
      outcome: notes.length === 0 ? 'valid' : 'invalid',
    },
  });
}

return out;
