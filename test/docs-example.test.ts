/** Pins docs/example.md's order-schema walkthrough. */
import { describe, expect, it } from "vitest";
import { schema, record, field, ref, t, parseSchema, readOml, Doc } from "../src/index.js";

const SCHEMA = `
record Address  { "street": string, "city": string }
record LineItem { "sku": string, "qty": integer, "price": number }

record Order {
    "id":      string,
    "status":  string,
    "total":   number,
    "address": Address,
    "items" [1,]: LineItem,
    "coupon" [0,1]: string,
}

record Root { "order": Order }
root Root
`;

const OML = `
order: {
    id: "A1"
    status: "shipped"
    total: 42.50
    address: {
        street: "1 Main St"
        city: "Springfield"
    }
    items: {
        sku: "WIDGET-1"
        qty: 2
        price: 15.00
    }
    items: {
        sku: "GADGET-2"
        qty: 1
        price: 12.50
    }
}
`;

describe("example schema validates the order document", () => {
  it("via OSD parseSchema", () => {
    const s = parseSchema(SCHEMA);
    const d = new Doc(readOml(OML));
    expect(s.validate(d).ok).toBe(true);
  });

  it("via the builder functions", () => {
    const address = record(field("street", t.string), field("city", t.string));
    const lineItem = record(
      field("sku", t.string), field("qty", t.integer), field("price", t.number),
    );
    const order = record(
      field("id", t.string),
      field("status", t.string),
      field("total", t.number),
      field("address", ref("Address")),
      field("items", ref("LineItem"), 1, null),
      field("coupon", t.string, 0, 1),
    );
    const s = schema(ref("Root"), {
      Root: record(field("order", ref("Order"))),
      Order: order,
      Address: address,
      LineItem: lineItem,
    });
    const d = new Doc(readOml(OML));
    expect(s.validate(d).ok).toBe(true);
  });
});
