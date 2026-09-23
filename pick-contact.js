// Plan step 7: choose the best existing Contact, or prepare the body to create one.
const lc = (s) => String(s || '').trim().toLowerCase();

return $input.all().map((it, i) => {
  const base = $('Resolve Tenant').itemMatching(i).json;
  const contacts = it.json.Contacts || [];
  const { vendor_name, vendor_email } = base.extracted;

  let match = null;
  let contactMatch = null;

  if (vendor_email) {
    match = contacts.find((c) => lc(c.EmailAddress) === lc(vendor_email));
    if (match) contactMatch = 'email';
  }
  if (!match) {
    match = contacts.find((c) => lc(c.Name) === lc(vendor_name));
    if (match) contactMatch = 'name (exact)';
  }
  if (!match && contacts.length > 0) {
    match = contacts[0];
    contactMatch = 'name (partial)';
  }

  const newContact = { Name: vendor_name };
  if (vendor_email) newContact.EmailAddress = vendor_email;

  // Dedupe layer 2 lookup: does this vendor already have a bill with this invoice number?
  // (A contact we are about to create cannot have one, so that path skips the lookup.)
  const clean = (s) => String(s).replace(/["\\]/g, '');
  const billWhere = match
    ? `Type=="ACCPAY" AND Contact.ContactID==Guid("${match.ContactID}") ` +
      `AND InvoiceNumber=="${clean(base.extracted.invoice_number)}"`
    : null;

  return {
    json: {
      ...base,
      contactFound: Boolean(match),
      contactId: match ? match.ContactID : null,
      contactName: match ? match.Name : vendor_name,
      contactMatch,
      billWhere,
      newContactBody: { Contacts: [newContact] },
    },
  };
});
