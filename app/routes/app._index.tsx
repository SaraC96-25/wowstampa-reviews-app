import { useEffect, useMemo } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type ProductOption = { id: string; title: string; handle: string };
type ReviewSummary = {
  id: string;
  productId: string | null;
  productHandle: string | null;
  productTitle: string | null;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  authorType: string | null;
  tag: string | null;
  photoUrl: string | null;
  verified: boolean;
  published: boolean;
  reviewDate: string | null;
};
type LoaderData = {
  products: ProductOption[];
  reviews: ReviewSummary[];
  appUrl: string;
  shop: string;
};
type ActionData = { ok: boolean; message?: string; errors?: string[] };
type ProductReviewInput = {
  shop: string;
  productId?: string | null;
  productHandle?: string | null;
  productTitle?: string | null;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  authorType?: string | null;
  tag?: string | null;
  photoUrl?: string | null;
  verified: boolean;
  published: boolean;
  source: string;
  reviewDate?: Date | string | null;
};

const reviewClient = (prisma as any).productReview;

const PRODUCTS_QUERY = `#graphql
  query WowReviewsProducts {
    products(first: 100, sortKey: TITLE) {
      edges {
        node {
          id
          title
          handle
        }
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(PRODUCTS_QUERY);
  const json: any = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error: any) => error.message).join("\n"));
  }

  const products: ProductOption[] = json.data.products.edges.map(({ node }: any) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
  }));
  const reviews = await reviewClient.findMany({
    where: { shop: session.shop },
    orderBy: [{ published: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  return {
    products,
    reviews: reviews.map(mapReview),
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    shop: session.shop,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "create");

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    await reviewClient.deleteMany({ where: { id, shop: session.shop } });
    return { ok: true, message: "Recensione eliminata." } satisfies ActionData;
  }

  if (intent === "toggle") {
    const id = String(formData.get("id") ?? "");
    const published = String(formData.get("published") ?? "false") === "true";
    await reviewClient.updateMany({ where: { id, shop: session.shop }, data: { published } });
    return {
      ok: true,
      message: published ? "Recensione pubblicata." : "Recensione nascosta.",
    } satisfies ActionData;
  }

  if (intent === "import") {
    const csvFile = formData.get("csvFile");
    const pastedCsv = String(formData.get("csvText") ?? "").trim();
    const csvText =
      csvFile && typeof (csvFile as any).text === "function"
        ? await (csvFile as any).text()
        : pastedCsv;
    const reviews = parseCsv(csvText)
      .map((row) => rowToReview(row, session.shop))
      .filter((review): review is ProductReviewInput => Boolean(review));

    if (!reviews.length) {
      return {
        ok: false,
        errors: ["Nessuna recensione valida trovata nel CSV."],
      } satisfies ActionData;
    }

    await reviewClient.createMany({ data: reviews });
    return { ok: true, message: `${reviews.length} recensioni importate.` } satisfies ActionData;
  }

  const product = parseSelectedProduct(String(formData.get("product") ?? ""));
  const review = normalizeReview({
    shop: session.shop,
    productId: product.id,
    productHandle: product.handle,
    productTitle: product.title,
    rating: Number(formData.get("rating") ?? 5),
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    authorName: String(formData.get("authorName") ?? ""),
    authorType: String(formData.get("authorType") ?? ""),
    tag: String(formData.get("tag") ?? ""),
    photoUrl: String(formData.get("photoUrl") ?? ""),
    verified: String(formData.get("verified") ?? "true") === "true",
    published: String(formData.get("published") ?? "true") === "true",
    source: "manual",
    reviewDate: String(formData.get("reviewDate") ?? ""),
  });
  const errors = validateReview(review);
  if (errors.length) return { ok: false, errors } satisfies ActionData;

  await reviewClient.create({ data: review });
  return { ok: true, message: "Recensione salvata." } satisfies ActionData;
};

export default function ReviewsAdmin() {
  const { products, reviews, appUrl, shop } = useLoaderData() as LoaderData;
  const fetcher = useFetcher();
  const actionData = fetcher.data as ActionData | undefined;
  const shopify = useAppBridge();
  const publishedReviews = reviews.filter((review) => review.published);
  const averageRating = useMemo(() => {
    if (!publishedReviews.length) return "0.0";
    const total = publishedReviews.reduce((sum, review) => sum + review.rating, 0);
    return (total / publishedReviews.length).toFixed(1);
  }, [publishedReviews]);

  useEffect(() => {
    if (actionData?.ok && actionData.message) shopify.toast.show(actionData.message);
  }, [actionData, shopify]);

  return (
    <s-page heading="WOWstampa Reviews">
      <style>{styles}</style>
      <s-section>
        <div className="reviews-admin">
          <div className="reviews-hero">
            <div>
              <p className="reviews-kicker">App standalone</p>
              <h1>Recensioni WowStampa</h1>
              <p>
                Gestisci recensioni manuali o CSV e mostrale nel tema con il layout
                Trustpilot-style scelto.
              </p>
            </div>
            <div className="reviews-stat">
              <span>{averageRating}</span>
              <strong>★</strong>
              <small>{publishedReviews.length} pubblicate</small>
            </div>
          </div>

          {actionData?.errors?.length ? (
            <div className="reviews-errors">
              {actionData.errors.map((error) => <p key={error}>{error}</p>)}
            </div>
          ) : null}

          <div className="reviews-grid">
            <fetcher.Form method="post" className="reviews-panel">
              <input name="intent" type="hidden" value="create" />
              <div className="reviews-panel__head">
                <h2>Aggiungi recensione</h2>
                <button className="reviews-button reviews-button--primary" type="submit">
                  Salva
                </button>
              </div>

              <label className="reviews-field">
                <span>Prodotto</span>
                <select name="product" required>
                  <option value="">Seleziona prodotto</option>
                  {products.map((product) => (
                    <option key={product.id} value={JSON.stringify(product)}>
                      {product.title}
                    </option>
                  ))}
                </select>
              </label>

              <div className="reviews-field-grid">
                <label className="reviews-field">
                  <span>Valutazione</span>
                  <select name="rating" defaultValue="5">
                    <option value="5">5 stelle</option>
                    <option value="4">4 stelle</option>
                    <option value="3">3 stelle</option>
                    <option value="2">2 stelle</option>
                    <option value="1">1 stella</option>
                  </select>
                </label>
                <label className="reviews-field">
                  <span>Data</span>
                  <input name="reviewDate" type="date" />
                </label>
              </div>

              <label className="reviews-field">
                <span>Titolo</span>
                <input name="title" placeholder="Colori brillanti e materiale resistente" required />
              </label>
              <label className="reviews-field">
                <span>Testo</span>
                <textarea name="body" placeholder="Ho ordinato un banner in PVC 510g..." required rows={5} />
              </label>

              <div className="reviews-field-grid">
                <label className="reviews-field">
                  <span>Nome cliente</span>
                  <input name="authorName" placeholder="Luca B." required />
                </label>
                <label className="reviews-field">
                  <span>Tipo cliente</span>
                  <input name="authorType" placeholder="Azienda" />
                </label>
              </div>

              <div className="reviews-field-grid">
                <label className="reviews-field">
                  <span>Tag prodotto</span>
                  <input name="tag" placeholder="Banner PVC 510g" />
                </label>
                <label className="reviews-field">
                  <span>URL foto cliente</span>
                  <input name="photoUrl" placeholder="https://cdn.shopify.com/..." type="url" />
                </label>
              </div>

              <div className="reviews-checks">
                <label><input name="verified" type="checkbox" value="true" defaultChecked /> Verificata</label>
                <label><input name="published" type="checkbox" value="true" defaultChecked /> Pubblicata</label>
              </div>
            </fetcher.Form>

            <fetcher.Form method="post" encType="multipart/form-data" className="reviews-panel">
              <input name="intent" type="hidden" value="import" />
              <div className="reviews-panel__head">
                <h2>Import CSV</h2>
                <button className="reviews-button" type="submit">Importa</button>
              </div>
              <p className="reviews-muted">
                Colonne: product_id, product_handle, product_title, rating, title,
                body, author_name, author_type, tag, photo_url, verified, published, review_date.
              </p>
              <label className="reviews-field">
                <span>File CSV</span>
                <input accept=".csv,text/csv" name="csvFile" type="file" />
              </label>
              <label className="reviews-field">
                <span>Oppure incolla CSV</span>
                <textarea name="csvText" rows={10} placeholder={"product_handle,rating,title,body,author_name,tag\nbanner-300x100,5,Perfetto,Stampa bellissima,Luca B.,Banner PVC 510g"} />
              </label>
              <div className="reviews-endpoint">
                <strong>Endpoint tema</strong>
                <code>{appUrl || "APP_URL"}/api/reviews?shop={shop}&productId={"{{ product.id }}"}</code>
              </div>
            </fetcher.Form>
          </div>

          <section className="reviews-panel reviews-panel--wide">
            <div className="reviews-panel__head">
              <h2>Recensioni salvate</h2>
              <span className="reviews-muted">{reviews.length} totali</span>
            </div>
            <div className="reviews-list">
              {reviews.map((review) => (
                <article className={`reviews-row ${review.published ? "" : "is-muted"}`} key={review.id}>
                  <div>
                    <div className="reviews-stars">{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</div>
                    <h3>{review.title}</h3>
                    <p>{review.body}</p>
                    <small>{review.authorName}{review.authorType ? ` · ${review.authorType}` : ""}{review.productTitle ? ` · ${review.productTitle}` : ""}</small>
                  </div>
                  {review.photoUrl ? <img src={review.photoUrl} alt="" /> : <span className="reviews-photo-empty">No foto</span>}
                  <div className="reviews-row-actions">
                    <fetcher.Form method="post">
                      <input name="intent" type="hidden" value="toggle" />
                      <input name="id" type="hidden" value={review.id} />
                      <input name="published" type="hidden" value={String(!review.published)} />
                      <button className="reviews-button" type="submit">{review.published ? "Nascondi" : "Pubblica"}</button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input name="intent" type="hidden" value="delete" />
                      <input name="id" type="hidden" value={review.id} />
                      <button className="reviews-button reviews-button--danger" type="submit">Elimina</button>
                    </fetcher.Form>
                  </div>
                </article>
              ))}
              {!reviews.length ? <p className="reviews-muted reviews-empty-list">Ancora nessuna recensione salvata.</p> : null}
            </div>
          </section>
        </div>
      </s-section>
    </s-page>
  );
}

function mapReview(review: any): ReviewSummary {
  return {
    id: review.id,
    productId: review.productId,
    productHandle: review.productHandle,
    productTitle: review.productTitle,
    rating: review.rating,
    title: review.title,
    body: review.body,
    authorName: review.authorName,
    authorType: review.authorType,
    tag: review.tag,
    photoUrl: review.photoUrl,
    verified: review.verified,
    published: review.published,
    reviewDate: review.reviewDate?.toISOString() ?? null,
  };
}

function parseSelectedProduct(value: string): ProductOption {
  try {
    const product = JSON.parse(value);
    return { id: String(product.id ?? ""), title: String(product.title ?? ""), handle: String(product.handle ?? "") };
  } catch {
    return { id: "", title: "", handle: "" };
  }
}

function normalizeReview(input: ProductReviewInput): ProductReviewInput {
  return {
    ...input,
    productId: clean(input.productId),
    productHandle: clean(input.productHandle),
    productTitle: clean(input.productTitle),
    rating: Math.min(5, Math.max(1, Math.round(Number(input.rating) || 5))),
    title: input.title.trim(),
    body: input.body.trim(),
    authorName: input.authorName.trim(),
    authorType: clean(input.authorType),
    tag: clean(input.tag),
    photoUrl: clean(input.photoUrl),
    verified: Boolean(input.verified),
    published: Boolean(input.published),
    reviewDate: parseDate(input.reviewDate),
  };
}

function validateReview(review: ProductReviewInput) {
  const errors: string[] = [];
  if (!review.productId && !review.productHandle) errors.push("Seleziona un prodotto o indica un handle nel CSV.");
  if (!review.title) errors.push("Inserisci il titolo della recensione.");
  if (!review.body) errors.push("Inserisci il testo della recensione.");
  if (!review.authorName) errors.push("Inserisci il nome cliente.");
  return errors;
}

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function parseDate(value: unknown) {
  if (value instanceof Date) return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseBoolean(value: unknown, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "si", "sì", "published", "pubblicata"].includes(text);
}

function rowToReview(row: Record<string, string>, shop: string) {
  const review = normalizeReview({
    shop,
    productId: row.product_id || row.productId,
    productHandle: row.product_handle || row.productHandle || row.handle,
    productTitle: row.product_title || row.productTitle || row.product,
    rating: Number(row.rating || row.stars || row.voto || 5),
    title: row.title || row.titolo,
    body: row.body || row.text || row.testo || row.review,
    authorName: row.author_name || row.authorName || row.nome || row.customer,
    authorType: row.author_type || row.authorType || row.tipo,
    tag: row.tag || row.product_tag || row.productTag,
    photoUrl: row.photo_url || row.photoUrl || row.image || row.image_url,
    verified: parseBoolean(row.verified || row.verificata, true),
    published: parseBoolean(row.published || row.pubblicata, true),
    source: "csv",
    reviewDate: row.review_date || row.reviewDate || row.data,
  });
  return validateReview(review).length ? null : review;
}

function parseCsv(csv: string) {
  const rows = csvToRows(csv.trim());
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((row) =>
    headers.reduce<Record<string, string>>((result, header, index) => {
      result[header] = row[index]?.trim() ?? "";
      return result;
    }, {}),
  );
}

function csvToRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

const styles = `
  .reviews-admin { display: grid; gap: 18px; margin: 0 auto; max-width: 1180px; width: 100%; }
  .reviews-hero, .reviews-panel, .reviews-errors { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 1px 0 rgba(0,0,0,.04); padding: 18px; }
  .reviews-hero { display: flex; justify-content: space-between; gap: 18px; align-items: center; }
  .reviews-hero h1, .reviews-panel h2, .reviews-row h3 { color: #202223; margin: 0; }
  .reviews-hero p, .reviews-muted, .reviews-row p { color: #6d7175; }
  .reviews-kicker { color: #008060; font-size: 12px; font-weight: 800; margin: 0 0 4px; text-transform: uppercase; }
  .reviews-stat { align-items: center; background: #edf7f4; border-radius: 12px; color: #006c52; display: grid; justify-items: center; min-width: 128px; padding: 16px; }
  .reviews-stat span { color: #202223; font-size: 44px; font-weight: 850; line-height: 1; }
  .reviews-stat strong { font-size: 28px; }
  .reviews-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .8fr); gap: 18px; align-items: start; }
  .reviews-panel__head { align-items: center; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .reviews-field, .reviews-field-grid { display: grid; gap: 7px; }
  .reviews-field { margin-bottom: 12px; }
  .reviews-field-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .reviews-field span { color: #6d7175; font-size: 11px; font-weight: 750; text-transform: uppercase; }
  .reviews-field input, .reviews-field select, .reviews-field textarea { border: 1px solid #c9cccf; border-radius: 6px; box-sizing: border-box; font: inherit; min-height: 36px; padding: 7px 10px; width: 100%; }
  .reviews-button { background: #fff; border: 1px solid #8c9196; border-radius: 6px; color: #202223; cursor: pointer; font: inherit; font-weight: 700; min-height: 36px; padding: 7px 12px; }
  .reviews-button--primary { background: #008060; border-color: #008060; color: #fff; }
  .reviews-button--danger { border-color: #d72c0d; color: #d72c0d; }
  .reviews-checks { display: flex; gap: 18px; font-weight: 700; }
  .reviews-checks label { align-items: center; display: inline-flex; gap: 7px; }
  .reviews-endpoint { background: #f6f6f7; border-radius: 6px; display: grid; gap: 6px; padding: 10px; }
  .reviews-endpoint code { overflow-wrap: anywhere; }
  .reviews-errors { background: #fff4f4; border-color: #fed3d1; color: #8e1f0b; }
  .reviews-errors p { margin: 0; }
  .reviews-panel--wide { padding: 0; }
  .reviews-panel--wide .reviews-panel__head { border-bottom: 1px solid #dfe3e8; margin: 0; padding: 18px; }
  .reviews-list { display: grid; }
  .reviews-row { align-items: center; border-bottom: 1px solid #dfe3e8; display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) 110px auto; padding: 16px 18px; }
  .reviews-row.is-muted { opacity: .55; }
  .reviews-stars { color: #ffb72b; font-weight: 900; margin-bottom: 4px; }
  .reviews-row img, .reviews-photo-empty { border-radius: 8px; height: 74px; object-fit: cover; width: 110px; }
  .reviews-photo-empty { align-items: center; background: #f6f6f7; color: #6d7175; display: flex; justify-content: center; font-size: 12px; font-weight: 700; }
  .reviews-row-actions { display: flex; gap: 8px; }
  .reviews-empty-list { padding: 18px; }
  @media (max-width: 900px) { .reviews-hero, .reviews-grid, .reviews-row { grid-template-columns: 1fr; display: grid; } .reviews-field-grid { grid-template-columns: 1fr; } }
`;

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
