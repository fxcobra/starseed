import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Meilisearch } from "meilisearch";
function needEnv(name) {
    const v = (process.env[name] ?? "").trim();
    if (!v)
        throw new Error(`Missing env: ${name}`);
    return v;
}
async function main() {
    const supabaseUrl = needEnv("SUPABASE_URL");
    const supabaseKey = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY ?? "").trim();
    if (!supabaseKey)
        throw new Error("Missing env: SUPABASE_SERVICE_KEY (recommended) or SUPABASE_KEY");
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const host = needEnv("MEILISEARCH_HOST");
    const apiKey = (process.env.MEILISEARCH_API_KEY ?? "").trim();
    const meili = new Meilisearch({ host, apiKey: apiKey || undefined });
    const indexName = (process.env.MEILISEARCH_PRODUCTS_INDEX ?? "products").trim() || "products";
    const index = meili.index(indexName);
    await index.updateFilterableAttributes(["vendor_id", "category", "price"]);
    await index.updateSearchableAttributes(["name", "title", "description", "category"]);
    const pageSize = 1000;
    let from = 0;
    let total = 0;
    while (true) {
        const { data, error } = await supabase
            .from("products_with_variations")
            .select("id,vendor_id,name,description,category,currency,price,images")
            .order("id", { ascending: true })
            .range(from, from + pageSize - 1);
        if (error)
            throw new Error(`Supabase error: ${error.message}`);
        const rows = Array.isArray(data) ? data : [];
        if (!rows.length)
            break;
        const docs = rows
            .map((r) => {
            const id = typeof r?.id === "number" ? r.id : Number(r?.id);
            const vendor_id = typeof r?.vendor_id === "string" ? r.vendor_id.trim() : String(r?.vendor_id ?? "").trim();
            const name = typeof r?.name === "string" ? r.name.trim() : "";
            if (!Number.isFinite(id) || id <= 0 || !vendor_id || !name)
                return null;
            const images = Array.isArray(r?.images) ? r.images.filter((x) => typeof x === "string" && x.trim() !== "") : [];
            const price = typeof r?.price === "number" && Number.isFinite(r.price) ? r.price : Number(r?.price ?? 0);
            const doc = {
                id,
                vendor_id,
                name,
                description: typeof r?.description === "string" ? r.description : "",
                category: typeof r?.category === "string" ? r.category : "",
                currency: typeof r?.currency === "string" ? r.currency : "",
                price: Number.isFinite(price) ? price : 0,
                images,
            };
            return doc;
        })
            .filter((x) => x !== null);
        if (docs.length) {
            await index.addDocuments(docs);
            total += docs.length;
            process.stdout.write(`indexed ${total}\n`);
        }
        from += pageSize;
    }
}
main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
