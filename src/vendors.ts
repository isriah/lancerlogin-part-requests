// The supported stores: labels and hosts only. Reading product pages stays in the browser extension, and the server decides
// the vendor from the product address, never from anything the extension says about it. Ported from the extension's list.

export type Vendor = { readonly id: string; readonly label: string; readonly hosts: readonly string[] };

function vendor(id: string, label: string, host: string): Vendor {
  return { id, label, hosts: [host, `www.${host}`, `m.${host}`, `mobile.${host}`] };
}

export const vendors: readonly Vendor[] = [
  vendor("amazon", "Amazon", "amazon.com"),
  { id: "aliexpress", label: "Ali Express", hosts: ["aliexpress.com", "www.aliexpress.com", "m.aliexpress.com", "mobile.aliexpress.com", "aliexpress.us", "www.aliexpress.us", "m.aliexpress.us"] },
  vendor("ambrosia", "Ambrosia Filament", "ambrosiafilament.com"),
  vendor("andymark", "AndyMark", "andymark.com"),
  { id: "bambu", label: "BambuLab", hosts: ["us.store.bambulab.com", "www.us.store.bambulab.com"] },
  { id: "ctre", label: "CTRE", hosts: ["store.ctr-electronics.com", "www.store.ctr-electronics.com"] },
  vendor("ferrules", "FerrulesDirect", "ferrulesdirect.com"),
  vendor("harborfreight", "Harbor Freight", "harborfreight.com"),
  vendor("homedepot", "Home Depot", "homedepot.com"),
  vendor("mcmaster", "McMaster", "mcmaster.com"),
  vendor("onlinemetals", "Online Metals", "onlinemetals.com"),
  vendor("pololu", "Pololu", "pololu.com"),
  vendor("powerwerx", "PowerWerx", "powerwerx.com"),
  vendor("rev", "REV", "revrobotics.com"),
  vendor("sds", "SDS", "swervedrivespecialties.com"),
  vendor("swyft", "Swyft", "swyftrobotics.com"),
  vendor("thrifty", "Thrifty Bot", "thethriftybot.com"),
  vendor("vbelts", "V-Belt Guys", "vbeltguys.com"),
  vendor("wcp", "WCP", "wcproducts.com"),
  vendor("west3d", "West3D", "west3d.com"),
];

export function vendorForUrl(raw: string): Vendor | undefined {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    return vendors.find((item) => item.hosts.includes(url.hostname.toLowerCase()));
  } catch { return undefined; }
}

/**
 * What makes two requests the same product for the repeat warning: the store, the path, and Shopify's selected variant.
 * Other query values and the mobile or www host do not matter. Undefined when the address is not from a supported store.
 */
export function productUrlKey(raw: string): string | undefined {
  const store = vendorForUrl(raw);
  if (!store) return undefined;
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  const variant = url.searchParams.get("variant");
  return `${store.id}:${path}${variant ? `?variant=${variant}` : ""}`;
}

/** The same product by its SKU at the same store, or an empty string when there is no SKU. */
export function productSkuKey(raw: string, sku: string): string {
  const store = vendorForUrl(raw);
  const value = sku.trim().toLowerCase();
  return store && value ? `${store.id}:${value}` : "";
}
