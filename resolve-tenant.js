// Plan step 6: use the first connected Xero organisation (known limitation: no disambiguation).
// Also prepares the contact search so the HTTP node only has to send it.
const connections = $input.all().map((i) => i.json).filter((c) => c && c.tenantId);
if (connections.length === 0) {
  throw new Error('Xero /connections returned no organisations for this credential');
}
const tenantId = connections[0].tenantId;
const tenantName = connections[0].tenantName || '';
const otherOrgs = connections.slice(1).map((c) => c.tenantName || c.tenantId);

// Xero "where" strings have no escape mechanism worth relying on: drop quotes/backslashes.
const clean = (s) => String(s).replace(/["\\]/g, '').trim();

return $('Parse & Validate')
  .all()
  .filter((i) => i.json.valid)
  .map((i) => {
    const { vendor_name, vendor_email } = i.json.extracted;
    // Email match first; the name clause also catches an existing contact with no email on file,
    // which matters because Xero rejects creating a second contact with the same name.
    const contactWhere = vendor_email
      ? `EmailAddress=="${clean(vendor_email)}" OR Name.Contains("${clean(vendor_name)}")`
      : `Name.Contains("${clean(vendor_name)}")`;
    return { json: { ...i.json, tenantId, tenantName, otherOrgs, contactWhere } };
  });
