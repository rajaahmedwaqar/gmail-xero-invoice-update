// Runs after either contact path:
//  - contact found   -> input is the "Check Existing Bill" response ({ Invoices })
//  - contact created -> input is the "Create Contact" response ({ Contacts })
// Skips the bill if Xero already has it, otherwise builds the payload (plan step 8).
const BILL_STATUS = 'DRAFT'; // hard requirement: never AUTHORISED

// Your Xero organisation's purchase tax type code (e.g. "INPUT"; codes vary per org and country).
// When set, each line carries this TaxType plus its share of the invoice's tax_amount so the draft's
// total matches the invoice. Empty = send no tax info (Xero may then show the pre-tax total).
// To find the code: open an existing bill with tax in Xero's API Explorer / GET Invoices and read
// LineItems[].TaxType.
const TAX_TYPE = 'INPUT';

const round2 = (n) => Math.round(n * 100) / 100;

// Split the invoice's tax across lines in proportion to line amounts; the last line absorbs rounding.
const allocateTax = (lines, tax) => {
  const amounts = lines.map((li) => li.quantity * li.unit_price);
  const base = amounts.reduce((a, b) => a + b, 0);
  if (!(base > 0)) return null;
  let allocated = 0;
  return amounts.map((amt, n) => {
    const share = n === amounts.length - 1 ? round2(tax - allocated) : round2((tax * amt) / base);
    allocated += share;
    return share;
  });
};

return $input.all().map((it, i) => {
  const base = $('Pick Contact').itemMatching(i).json;
  let { contactId, contactName, contactMatch } = base;

  if (it.json.Contacts) {
    const contact = it.json.Contacts[0];
    if (!contact || !contact.ContactID) {
      throw new Error(`Xero did not return a ContactID when creating "${base.extracted.vendor_name}"`);
    }
    contactId = contact.ContactID;
    contactName = contact.Name;
    contactMatch = 'created new contact';
  } else {
    const existing = (it.json.Invoices || []).filter(
      (inv) => !['VOIDED', 'DELETED'].includes(inv.Status)
    );
    if (existing.length > 0) {
      const inv = existing[0];
      return {
        json: {
          ...base,
          duplicate: true,
          outcome: 'duplicate',
          existingBill: { id: inv.InvoiceID, number: inv.InvoiceNumber, status: inv.Status },
        },
      };
    }
  }

  const { extracted } = base;
  const tax = extracted.tax_amount;
  const taxShares = TAX_TYPE && typeof tax === 'number' && tax > 0 ? allocateTax(extracted.line_items, tax) : null;

  const bill = {
    Type: 'ACCPAY',
    Contact: { ContactID: contactId },
    Date: base.billDate,
    DueDate: base.billDueDate,
    InvoiceNumber: extracted.invoice_number,
    Reference: extracted.invoice_number,
    // No AccountCode, Total or SubTotal: not needed for a draft; Xero computes totals itself.
    LineItems: extracted.line_items.map((li, n) => ({
      Description: li.description || 'Invoice line',
      Quantity: li.quantity,
      UnitAmount: li.unit_price,
      ...(taxShares ? { TaxType: TAX_TYPE, TaxAmount: taxShares[n] } : {}),
    })),
    ...(taxShares ? { LineAmountTypes: 'Exclusive' } : {}),
    Status: BILL_STATUS,
  };

  if (bill.Status !== 'DRAFT' || bill.Type !== 'ACCPAY') {
    throw new Error('Refusing to build a bill that is not an ACCPAY DRAFT');
  }

  return {
    json: {
      ...base,
      contactId,
      contactName,
      contactMatch,
      duplicate: false,
      billBody: { Invoices: [bill] },
    },
  };
});
