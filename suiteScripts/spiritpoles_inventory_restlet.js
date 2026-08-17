/**
 * spiritpoles_inventory_restlet.js
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 *
 * Called via TBA OAuth 1.0a GET from the Cloudflare Pages Function (inventory.js).
 * Returns: { flexes: [...], ufBalance: [...], generatedAt: "ISO string" }
 *
 * flexes[]    — lot/serial records for finished (lot-tracked) poles.
 *               Each: { modelname, displayname, lotnumber, lotonhand, lotavailable }
 *               lotnumber format: "flex|model|date|time" e.g. "37.0|370|24-06-03|9:49"
 *
 * ufBalance[] — UF blank item quantities (multi-location, non-lot-tracked).
 *               Each: { itemid, quantityonhand, quantityavailable, quantitycommitted }
 *
 * Deployment setup (one-time):
 *   1. Upload this file to File Cabinet → SuiteScripts/
 *   2. Customization → Scripting → Scripts → New
 *        Type: RESTlet  |  Name: Spirit Poles Inventory RESTlet
 *        GET Function: get
 *   3. Save → Deployments tab → New Deployment
 *        Status: Released  |  Log Level: Error
 *        Roles: add CEO (and any other role that needs to call it)
 *   4. Note the Script ID (e.g. 123) and Deployment ID (e.g. 1).
 *   5. RESTlet URL:
 *        https://{accountId}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script={scriptId}&deploy={deployId}
 *   6. Add to Cloudflare Pages env vars:  NS_RESTLET_URL = <that URL>
 */

define(['N/search', 'N/log'], (search, log) => {

  const MAX_ROWS = 3000; // safety cap — well above expected pole inventory size

  /**
   * GET handler — returns inventory snapshot as a plain object (NetSuite auto-serializes to JSON).
   */
  function get(/* params */) {
    const result = {
      flexes:    [],
      ufBalance: [],
      generatedAt: new Date().toISOString(),
    };

    // ── 1. Lot/serial numbers for finished (lot-tracked) poles ───────────────
    // The lot number encodes the flex rating: "37.0|370|24-06-03|9:49"
    // N/search on INVENTORY_NUMBER is accessible to any role with Items permission —
    // unlike the SuiteQL inventoryNumber table which requires Inventory Register.
    try {
      const flexSearch = search.create({
        type: search.Type.INVENTORY_NUMBER,
        filters: [
          ['quantityonhand', 'greaterthan', '0'],
          'AND',
          ['isinactive', 'is', 'F'],
          'AND',
          ['item.isinactive', 'is', 'F'],
        ],
        columns: [
          search.createColumn({ name: 'name' }),                             // lot number string
          search.createColumn({ name: 'quantityonhand' }),
          search.createColumn({ name: 'quantityavailable' }),
          search.createColumn({ name: 'itemid',      join: 'item' }),        // e.g. "370/40"
          search.createColumn({ name: 'displayname', join: 'item' }),        // e.g. "370/40 | 12'1\" - 90lb"
        ],
      });

      let count = 0;
      flexSearch.run().each(row => {
        result.flexes.push({
          lotnumber:    row.getValue('name'),
          lotonhand:    Number(row.getValue('quantityonhand'))    || 0,
          lotavailable: Number(row.getValue('quantityavailable')) || 0,
          modelname:    row.getValue({ name: 'itemid',      join: 'item' }),
          displayname:  row.getValue({ name: 'displayname', join: 'item' }),
        });
        return ++count < MAX_ROWS; // return false to stop iteration
      });

      log.audit({ title: 'flexes', details: `${result.flexes.length} lot records returned` });
    } catch (e) {
      log.error({ title: 'flexSearch failed', details: e.message });
      result.flexError = String(e.message).substring(0, 400);
    }

    // ── 2. UF blank on-hand quantities (multi-location, non-lot-tracked) ────
    // N/search on ITEM returns correct totals across all locations for non-lot items.
    // (Unlike SuiteQL item.quantityonhand which returns 0 for multi-location non-lot items.)
    try {
      const ufSearch = search.create({
        type: search.Type.ITEM,
        filters: [
          ['name', 'startswith', 'UF'],
          'AND',
          ['isinactive', 'is', 'F'],
        ],
        columns: [
          search.createColumn({ name: 'itemid' }),
          search.createColumn({ name: 'quantityonhand' }),
          search.createColumn({ name: 'quantityavailable' }),
          search.createColumn({ name: 'quantitycommitted' }),
        ],
      });

      let count = 0;
      ufSearch.run().each(row => {
        result.ufBalance.push({
          itemid:            row.getValue('itemid'),
          quantityonhand:    Number(row.getValue('quantityonhand'))    || 0,
          quantityavailable: Number(row.getValue('quantityavailable')) || 0,
          quantitycommitted: Number(row.getValue('quantitycommitted')) || 0,
        });
        return ++count < MAX_ROWS;
      });

      log.audit({ title: 'ufBalance', details: `${result.ufBalance.length} UF items returned` });
    } catch (e) {
      log.error({ title: 'ufSearch failed', details: e.message });
      result.ufError = String(e.message).substring(0, 400);
    }

    return result; // NetSuite serializes to JSON automatically
  }

  return { get };
});
