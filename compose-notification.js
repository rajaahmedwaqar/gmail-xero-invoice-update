// One composer for every outcome. Inputs (each is a different shape):
//  - Create Bill response   ({ Invoices })              -> success (also records the dedupe key)
//  - Duplicate? true        (outcome: 'duplicate')      -> skipped
//  - Valid? false           (outcome: 'invalid')        -> needs manual review
//  - On Workflow Error      ({ execution, workflow })   -> failure
const esc = (v) =>
  String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const money = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');
const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
const pre = (s) =>
  `<pre style="background:#f4f4f4;padding:8px;white-space:pre-wrap">${esc(s)}</pre>`;

const source = (j) =>
  `<p><b>Email:</b> ${esc(j.subject)}<br><b>From:</b> ${esc(j.fromAddress)}<br>` +
  `<b>Attachment:</b> ${esc(j.attachmentName)}</p>`;

const lineTable = (lines) =>
  '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">' +
  '<tr><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr>' +
  lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td>${esc(l.quantity)}</td>` +
        `<td>${money(l.unit_price)}</td><td>${money(l.total)}</td></tr>`
    )
    .join('') +
  '</table>';

// Find the Build Bill item that produced this Xero bill. Matching on invoice number + contact
// (not item position) stays correct when Build Bill ran more than once in a batch.
const findBuildBillItem = (inv) => {
  for (let run = 0; run < 5; run++) {
    let items;
    try {
      items = $('Build Bill').all(0, run);
    } catch (e) {
      break;
    }
    const hit = items.find((b) => {
      const sent = b.json.billBody && b.json.billBody.Invoices[0];
      return sent && sent.InvoiceNumber === inv.InvoiceNumber && sent.Contact.ContactID === (inv.Contact && inv.Contact.ContactID);
    });
    if (hit) return hit.json;
  }
  return null;
};

const store = $getWorkflowStaticData('global');
store.processed = store.processed || {};

const success = (inv) => {
  const j = findBuildBillItem(inv);
  if (j) {
    store.processed[j.dedupeKey] = { xeroInvoiceId: inv.InvoiceID, at: new Date().toISOString() };
  }
  // If the context can't be matched the bill still exists; report from Xero's own response.
  const e = j
    ? j.extracted
    : {
        vendor_name: inv.Contact && inv.Contact.Name,
        invoice_number: inv.InvoiceNumber,
        total_payable: null,
        line_items: (inv.LineItems || []).map((l) => ({
          description: l.Description,
          quantity: l.Quantity,
          unit_price: l.UnitAmount,
          total: l.LineAmount,
        })),
      };
  const url = `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.InvoiceID}`;
  const mismatch =
    typeof inv.Total === 'number' && typeof e.total_payable === 'number' && Math.abs(inv.Total - e.total_payable) > 0.01;

  let html = `<h3>Draft bill created</h3>${j ? source(j) : ''}`;
  if (j) {
    html +=
      `<p><b>Vendor:</b> ${esc(e.vendor_name)} (${esc(j.contactMatch)}` +
      `${j.contactMatch === 'name (partial)' ? ` - matched to existing contact "${esc(j.contactName)}", please check it is the right vendor` : ''})<br>`;
  } else {
    html += `<p><b>Vendor:</b> ${esc(e.vendor_name)}<br>`;
  }
  html +=
    `<b>Invoice #:</b> ${esc(e.invoice_number)}<br>` +
    `<b>Bill date:</b> ${esc(j ? j.billDate : inv.DateString)} &nbsp; <b>Due:</b> ${esc(j ? j.billDueDate : inv.DueDateString)}<br>` +
    `<b>Xero status:</b> ${esc(inv.Status)} &nbsp; <a href="${esc(url)}">Open in Xero</a></p>` +
    lineTable(e.line_items) +
    `<p><b>Invoice total:</b> ${money(e.total_payable)} &nbsp; <b>Xero total:</b> ${money(inv.Total)} ` +
    `(tax in Xero: ${money(inv.TotalTax)})</p>`;
  if (mismatch) {
    html +=
      `<p style="color:#b00020"><b>Xero's total differs from the invoice total.</b> ` +
      `No tax type is sent unless TAX_TYPE is set in the Build Bill node, so Xero may not have applied ` +
      `the invoice's tax. Review the draft before approving.</p>`;
  }
  if (inv.Status !== 'DRAFT') {
    html += `<p style="color:#b00020"><b>WARNING: Xero reports status ${esc(inv.Status)}, expected DRAFT.</b></p>`;
  }
  if (j && j.fallbacks.length) html += `<p><b>Defaults applied:</b></p>${list(j.fallbacks)}`;
  if (j && j.otherOrgs && j.otherOrgs.length) {
    html += `<p><i>Multiple Xero organisations are connected; used "${esc(j.tenantName)}" (first). Others: ${esc(j.otherOrgs.join(', '))}</i></p>`;
  }
  return { subject: `Draft bill created in Xero: ${e.vendor_name} #${e.invoice_number}`, html };
};

const failure = (j) => {
  const ex = j.execution || {};
  const err = ex.error || {};
  return {
    subject: `Invoice automation FAILED at "${ex.lastNodeExecuted || 'unknown node'}"`,
    html:
      `<h3>Invoice automation failed</h3>` +
      `<p><b>Workflow:</b> ${esc(j.workflow && j.workflow.name)}<br>` +
      `<b>Failed node:</b> ${esc(ex.lastNodeExecuted)}<br>` +
      `<b>Execution:</b> ${ex.url ? `<a href="${esc(ex.url)}">${esc(ex.id)}</a>` : esc(ex.id)}</p>` +
      pre(err.message || JSON.stringify(err, null, 2)) +
      `<p>The invoice was not marked as processed. Fix the cause, then use <b>Retry</b> on that execution ` +
      `in n8n. Nothing is duplicated: an existing Xero bill is detected before a new one is created.</p>`,
  };
};

return $input.all().map((item) => {
  const j = item.json;
  let msg;

  if (j.execution && j.workflow) {
    msg = failure(j);
  } else if (j.Invoices) {
    msg = success(j.Invoices[0]);
  } else if (j.outcome === 'duplicate') {
    msg = {
      subject: `Skipped: bill already exists in Xero (#${j.extracted.invoice_number})`,
      html:
        `<h3>No bill created: duplicate</h3>${source(j)}` +
        `<p>Xero already has a bill for ${esc(j.extracted.vendor_name)} with invoice number ` +
        `${esc(j.extracted.invoice_number)} (status ${esc(j.existingBill.status)}).</p>`,
    };
  } else {
    msg = {
      subject: `Invoice needs manual review: ${j.extracted && j.extracted.vendor_name ? j.extracted.vendor_name : j.subject}`,
      html:
        `<h3>Invoice needs manual review</h3>${source(j)}` +
        `<p>Nothing was created in Xero. Issues found:</p>${list(j.validation_notes)}` +
        `<p><b>Extracted data:</b></p>${pre(j.extracted ? JSON.stringify(j.extracted, null, 2) : j.raw_text || '(nothing extracted)')}`,
    };
  }

  return { json: msg };
});
