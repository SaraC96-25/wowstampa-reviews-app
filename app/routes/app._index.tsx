import { useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";

type ProductOption = { id: string; title: string; handle: string };
type ReviewSummary = {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
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
type ReviewCategorySummary = {
  id: string;
  key: string;
  name: string;
  productIds: string;
  productHandles: string;
};
type LoaderData = {
  products: ProductOption[];
  reviews: ReviewSummary[];
  categories: ReviewCategorySummary[];
  appUrl: string;
  shop: string;
  loadError?: string;
};
type ActionData = { ok: boolean; message?: string; errors?: string[] };
type ProductReviewInput = {
  shop: string;
  categoryId?: string | null;
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
const categoryClient = (prisma as any).reviewCategory;
const fallbackShop = process.env.SHOPIFY_SHOP_DOMAIN || "wowstampa.myshopify.com";

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
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";

  try {
    const { shop, products } = await getShopContext(request);
    const reviews = await loadReviews(shop);
    const categories = await loadCategories(shop);

    return {
      products,
      reviews: reviews.map(mapReview),
      categories: categories.map(mapCategory),
      appUrl,
      shop,
    } satisfies LoaderData;
  } catch (error) {
    console.error("WOWstampa reviews admin loader failed", error);
    return {
      products: [],
      reviews: [],
      categories: [],
      appUrl,
      shop: fallbackShop,
      loadError: "Dati recensioni momentaneamente non disponibili. Controlla le variabili Render e la migrazione Supabase.",
    } satisfies LoaderData;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    return await handleAction(request);
  } catch (error) {
    console.error("WOWstampa reviews admin action failed", error);
    return {
      ok: false,
      errors: ["Operazione non riuscita: controlla che Supabase sia aggiornato e riprova."],
    } satisfies ActionData;
  }
};

async function handleAction(request: Request) {
  const { shop } = await getShopContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "create");

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    await runDatabaseWrite("review delete", () => reviewClient.deleteMany({ where: { id, shop } }));
    return { ok: true, message: "Recensione eliminata." } satisfies ActionData;
  }

  if (intent === "create-category") {
    const name = String(formData.get("categoryName") ?? "").trim();
    const key = slugify(String(formData.get("categoryKey") ?? "") || name);
    const productHandles = normalizeListText(formData.get("categoryProductHandles"));
    const productIds = normalizeListText(formData.get("categoryProductIds"));

    if (!name || !key) {
      return { ok: false, errors: ["Inserisci nome e chiave categoria."] } satisfies ActionData;
    }

    try {
      await categoryClient.upsert({
        where: { shop_key: { shop, key } },
        create: { shop, key, name, productHandles, productIds },
        update: { name, productHandles, productIds },
      });
    } catch {
      return {
        ok: false,
        errors: ["Categorie non ancora disponibili: verifica che la migration Supabase sia stata applicata."],
      } satisfies ActionData;
    }

    return { ok: true, message: "Categoria recensioni salvata." } satisfies ActionData;
  }

  if (intent === "update-category") {
    const id = String(formData.get("id") ?? "");
    const name = String(formData.get("categoryName") ?? "").trim();
    const key = slugify(String(formData.get("categoryKey") ?? "") || name);
    const productHandles = normalizeListText(formData.get("categoryProductHandles"));
    const productIds = normalizeListText(formData.get("categoryProductIds"));

    if (!id || !name || !key) {
      return { ok: false, errors: ["Seleziona una categoria e inserisci nome e chiave."] } satisfies ActionData;
    }

    try {
      const result = await runDatabaseWrite<{ count?: number }>("category update", () =>
        categoryClient.updateMany({
          where: { id, shop },
          data: { name, key, productHandles, productIds },
        }),
      );

      if (!result.count) {
        return { ok: false, errors: ["Categoria non trovata."] } satisfies ActionData;
      }
    } catch {
      return {
        ok: false,
        errors: ["Categoria non salvata: verifica che la chiave non sia già usata da un'altra categoria."],
      } satisfies ActionData;
    }

    return { ok: true, message: "Categoria recensioni aggiornata." } satisfies ActionData;
  }

  if (intent === "delete-category") {
    const id = String(formData.get("id") ?? "");
    await runDatabaseWrite("category delete", () => categoryClient.deleteMany({ where: { id, shop } })).catch(() => null);
    return { ok: true, message: "Categoria eliminata." } satisfies ActionData;
  }

  if (intent === "toggle") {
    const id = String(formData.get("id") ?? "");
    const published = String(formData.get("published") ?? "false") === "true";
    await runDatabaseWrite("review publish toggle", () =>
      reviewClient.updateMany({ where: { id, shop }, data: { published } }),
    );
    return {
      ok: true,
      message: published ? "Recensione pubblicata." : "Recensione nascosta.",
    } satisfies ActionData;
  }

  if (intent === "dedupe-category-reviews") {
    const deletedCount = await deleteDuplicateCategoryReviews(shop);
    return {
      ok: true,
      message: deletedCount
        ? `${deletedCount} recensioni doppie eliminate.`
        : "Nessuna recensione doppia trovata nelle categorie.",
    } satisfies ActionData;
  }

  if (intent === "import") {
    const csvFile = formData.get("csvFile");
    const pastedCsv = String(formData.get("csvText") ?? "").trim();
    const csvText =
      csvFile && typeof (csvFile as any).text === "function"
        ? await (csvFile as any).text()
        : pastedCsv;
    const categories = await loadCategories(shop);
    const categoriesByName = createCategoryLookup(categories);
    const reviews = parseCsv(csvText)
      .map((row) => rowToReview(row, shop, categoriesByName))
      .filter((review): review is ProductReviewInput => Boolean(review));

    if (!reviews.length) {
      return {
        ok: false,
        errors: ["Nessuna recensione valida trovata nel CSV."],
      } satisfies ActionData;
    }

    await createReviews(reviews);
    return { ok: true, message: `${reviews.length} recensioni importate.` } satisfies ActionData;
  }

  const reviewScope = String(formData.get("reviewScope") ?? "product");
  const categoryOnly = reviewScope === "category";
  const product = categoryOnly ? emptyProductOption() : parseSelectedProduct(String(formData.get("product") ?? ""));
  const manualProductHandle = String(formData.get("manualProductHandle") ?? "");
  const manualProductTitle = String(formData.get("manualProductTitle") ?? "");
  const review = normalizeReview({
    shop,
    categoryId: String(formData.get("categoryId") ?? ""),
    productId: product.id,
    productHandle: categoryOnly ? "" : product.handle || manualProductHandle,
    productTitle: categoryOnly ? "" : product.title || manualProductTitle,
    rating: Number(formData.get("rating") ?? 5),
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    authorName: String(formData.get("authorName") ?? ""),
    authorType: String(formData.get("authorType") ?? ""),
    tag: String(formData.get("tag") ?? ""),
    photoUrl: String(formData.get("photoUrl") ?? ""),
    verified: String(formData.get("verified") ?? "true") === "true",
    published: String(formData.get("published") ?? "true") === "true",
    source: categoryOnly ? "category" : "manual",
    reviewDate: String(formData.get("reviewDate") ?? ""),
  });
  const errors = validateReview(review);
  if (errors.length) return { ok: false, errors } satisfies ActionData;

  await createReview(review);
  return { ok: true, message: "Recensione salvata." } satisfies ActionData;
}

async function createReviews(reviews: ProductReviewInput[]) {
  const data = reviews.map(stripEmptyCategoryId);

  try {
    await runDatabaseWrite("reviews full import", () => reviewClient.createMany({ data }));
  } catch (error) {
    console.error("WOWstampa reviews full import failed, retrying legacy payload", error);
    if (!isLegacySchemaError(error)) throw error;
    await runDatabaseWrite("reviews legacy import", () =>
      reviewClient.createMany({ data: reviews.map(toLegacyReviewInput) }),
    );
  }
}

async function createReview(review: ProductReviewInput) {
  try {
    await runDatabaseWrite("review full create", () =>
      reviewClient.createMany({ data: [stripEmptyCategoryId(review)] }),
    );
  } catch (error) {
    console.error("WOWstampa reviews full create failed, retrying legacy payload", error);
    if (!isLegacySchemaError(error)) throw error;
    await runDatabaseWrite("review legacy create", () =>
      reviewClient.createMany({ data: [toLegacyReviewInput(review)] }),
    );
  }
}

async function deleteDuplicateCategoryReviews(shop: string) {
  const reviews = await runDatabaseWrite<any[]>("duplicate category reviews query", () =>
    reviewClient.findMany({
      where: {
        shop,
        categoryId: { not: null },
      },
      select: {
        id: true,
        categoryId: true,
        title: true,
        body: true,
        authorName: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  const seen = new Set<string>();
  const duplicateIds: string[] = [];

  reviews.forEach((review: any) => {
    const key = [
      review.categoryId,
      normalizeDuplicateText(review.title),
      normalizeDuplicateText(review.body),
      normalizeDuplicateText(review.authorName),
    ].join("::");

    if (seen.has(key)) {
      duplicateIds.push(String(review.id));
    } else {
      seen.add(key);
    }
  });

  if (!duplicateIds.length) return 0;

  const result = await runDatabaseWrite<{ count?: number }>("duplicate category reviews delete", () =>
    reviewClient.deleteMany({
      where: {
        shop,
        id: { in: duplicateIds },
      },
    }),
  );

  return Number(result.count ?? duplicateIds.length);
}

async function loadReviews(shop: string): Promise<any[]> {
  try {
    return await runDatabaseWrite("reviews category query", () =>
      reviewClient.findMany({
        where: { shop },
        include: { category: true },
        orderBy: [{ published: "desc" }, { createdAt: "desc" }],
        take: 100,
      }),
    );
  } catch (error) {
    console.error("WOWstampa reviews category query failed", error);
    try {
      return await runDatabaseWrite("reviews fallback query", () =>
        reviewClient.findMany({
          where: { shop },
          select: {
            id: true,
            productId: true,
            productHandle: true,
            productTitle: true,
            rating: true,
            title: true,
            body: true,
            authorName: true,
            authorType: true,
            tag: true,
            photoUrl: true,
            verified: true,
            published: true,
            reviewDate: true,
          },
          orderBy: [{ published: "desc" }, { createdAt: "desc" }],
          take: 100,
        }),
      );
    } catch (fallbackError) {
      console.error("WOWstampa reviews fallback query failed", fallbackError);
      return [];
    }
  }
}

async function loadCategories(shop: string): Promise<any[]> {
  try {
    return await runDatabaseWrite("categories query", () =>
      categoryClient.findMany({
        where: { shop },
        orderBy: [{ name: "asc" }],
      }),
    );
  } catch {
    return [];
  }
}

async function getShopContext(request: Request) {
  try {
    const { admin, session } = await authenticate.admin(request);
    return { shop: session.shop, products: await loadProducts(admin) };
  } catch {
    try {
      const { admin, session } = await unauthenticated.admin(fallbackShop);
      return { shop: session.shop, products: await loadProducts(admin) };
    } catch {
      return { shop: fallbackShop, products: [] };
    }
  }
}

async function loadProducts(admin: { graphql: (query: string) => Promise<Response> }) {
  const response = await admin.graphql(PRODUCTS_QUERY);
  const json: any = await response.json();

  if (json.errors?.length) {
    return [];
  }

  return json.data.products.edges.map(({ node }: any) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
  })) satisfies ProductOption[];
}

export default function ReviewsAdmin() {
  const { products, reviews, categories, appUrl, shop, loadError } = useLoaderData() as LoaderData;
  const fetcher = useFetcher();
  const [reviewScope, setReviewScope] = useState<"product" | "category">("product");
  const actionData = fetcher.data as ActionData | undefined;
  const publishedReviews = reviews.filter((review) => review.published);
  const isCategoryReview = reviewScope === "category";
  const averageRating = useMemo(() => {
    if (!publishedReviews.length) return "0.0";
    const total = publishedReviews.reduce((sum, review) => sum + review.rating, 0);
    return (total / publishedReviews.length).toFixed(1);
  }, [publishedReviews]);

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

          {loadError ? (
            <div className="reviews-errors">
              <p>{loadError}</p>
            </div>
          ) : null}
          {actionData?.errors?.length ? (
            <div className="reviews-errors">
              {actionData.errors.map((error) => <p key={error}>{error}</p>)}
            </div>
          ) : null}
          {actionData?.ok && actionData.message ? (
            <div className="reviews-success">
              <p>{actionData.message}</p>
            </div>
          ) : null}

          <div className="reviews-grid">
            <fetcher.Form action="?index" method="post" className="reviews-panel">
              <input name="intent" type="hidden" value="create" />
              <div className="reviews-panel__head">
                <h2>Aggiungi recensione</h2>
                <button className="reviews-button reviews-button--primary" type="submit">
                  Salva
                </button>
              </div>

              <label className="reviews-field">
                <span>Ambito recensione</span>
                <select
                  name="reviewScope"
                  value={reviewScope}
                  onChange={(event) => setReviewScope(event.currentTarget.value as "product" | "category")}
                >
                  <option value="product">Prodotto singolo</option>
                  <option value="category">Solo categoria</option>
                </select>
              </label>

              {isCategoryReview ? (
                <div className="reviews-notice">
                  Questa recensione verra mostrata su tutti i prodotti inclusi nella categoria scelta.
                </div>
              ) : null}

              <label className="reviews-field">
                <span>Prodotto</span>
                <select name="product" disabled={isCategoryReview}>
                  <option value="">Seleziona prodotto</option>
                  {products.map((product) => (
                    <option key={product.id} value={JSON.stringify(product)}>
                      {product.title}
                    </option>
                  ))}
                </select>
              </label>
              {!products.length && !isCategoryReview ? (
                <div className="reviews-field-grid">
                  <label className="reviews-field">
                    <span>Handle prodotto</span>
                    <input name="manualProductHandle" placeholder="banner-300x100" />
                  </label>
                  <label className="reviews-field">
                    <span>Titolo prodotto</span>
                    <input name="manualProductTitle" placeholder="Banner 300x100" />
                  </label>
                </div>
              ) : null}

              <label className="reviews-field">
                <span>Categoria recensioni</span>
                <select name="categoryId" required={isCategoryReview}>
                  <option value="">Nessuna categoria</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
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

            <fetcher.Form action="?index" method="post" encType="multipart/form-data" className="reviews-panel">
              <input name="intent" type="hidden" value="import" />
              <div className="reviews-panel__head">
                <h2>Import CSV</h2>
                <button className="reviews-button" type="submit">Importa</button>
              </div>
              <p className="reviews-muted">
                Colonne: product_id, product_handle, product_title, rating, title,
                body, author_name, author_type, tag, photo_url, verified, published,
                review_date, categoria.
              </p>
              <label className="reviews-field">
                <span>File CSV</span>
                <input accept=".csv,text/csv" name="csvFile" type="file" />
              </label>
              <label className="reviews-field">
                <span>Oppure incolla CSV</span>
                <textarea name="csvText" rows={10} placeholder={"product_id,product_handle,product_title,rating,title,body,author_name,author_type,tag,photo_url,verified,published,review_date,categoria\n,banner-300x100,Banner 300x100,5,Perfetto,Stampa bellissima,Luca B.,Azienda,Banner PVC,,true,true,2026-05-29,Bandiere"} />
              </label>
              <div className="reviews-endpoint">
                <strong>Endpoint tema</strong>
                <code>{appUrl || "APP_URL"}/api/reviews?shop={shop}&productId={"{{ product.id }}"}</code>
              </div>
            </fetcher.Form>
          </div>

          <section className="reviews-panel reviews-panel--wide">
            <div className="reviews-panel__head">
              <h2>Categorie recensioni</h2>
              <span className="reviews-muted">{categories.length} categorie</span>
            </div>
            <div className="reviews-category-layout">
              <fetcher.Form action="?index" method="post" className="reviews-category-form">
                <input name="intent" type="hidden" value="create-category" />
                <div className="reviews-field-grid">
                  <label className="reviews-field">
                    <span>Nome categoria</span>
                    <input name="categoryName" placeholder="Banner PVC" required />
                  </label>
                  <label className="reviews-field">
                    <span>Chiave categoria</span>
                    <input name="categoryKey" placeholder="banner-pvc" />
                  </label>
                </div>
                <label className="reviews-field">
                  <span>Handle prodotti inclusi</span>
                  <textarea
                    name="categoryProductHandles"
                    rows={4}
                    placeholder={"banner-300x100\nbanner-500x200\nstriscioni-pubblicitari"}
                  />
                </label>
                <label className="reviews-field">
                  <span>ID prodotti inclusi opzionali</span>
                  <textarea
                    name="categoryProductIds"
                    rows={3}
                    placeholder={"gid://shopify/Product/123456789\n123456789"}
                  />
                </label>
                <button className="reviews-button reviews-button--primary" type="submit">
                  Salva categoria
                </button>
              </fetcher.Form>

              <div className="reviews-category-list">
                {categories.map((category) => (
                  <article className="reviews-category-row" key={category.id}>
                    <fetcher.Form action="?index" method="post" className="reviews-category-edit">
                      <input name="intent" type="hidden" value="update-category" />
                      <input name="id" type="hidden" value={category.id} />
                      <div className="reviews-field-grid">
                        <label className="reviews-field">
                          <span>Nome categoria</span>
                          <input name="categoryName" defaultValue={category.name} required />
                        </label>
                        <label className="reviews-field">
                          <span>Chiave categoria</span>
                          <input name="categoryKey" defaultValue={category.key} required />
                        </label>
                      </div>
                      <label className="reviews-field">
                        <span>Handle prodotti inclusi</span>
                        <textarea name="categoryProductHandles" rows={6} defaultValue={category.productHandles} />
                      </label>
                      <label className="reviews-field">
                        <span>ID prodotti inclusi opzionali</span>
                        <textarea name="categoryProductIds" rows={3} defaultValue={category.productIds} />
                      </label>
                      <button className="reviews-button reviews-button--primary" type="submit">Aggiorna categoria</button>
                    </fetcher.Form>
                    <fetcher.Form action="?index" method="post" className="reviews-category-delete">
                      <input name="intent" type="hidden" value="delete-category" />
                      <input name="id" type="hidden" value={category.id} />
                      <button
                        className="reviews-button reviews-button--danger"
                        type="submit"
                        onClick={(event) => {
                          if (!window.confirm("Vuoi eliminare questa categoria recensioni?")) {
                            event.preventDefault();
                          }
                        }}
                      >
                        Elimina
                      </button>
                    </fetcher.Form>
                  </article>
                ))}
                {!categories.length ? <p className="reviews-muted reviews-empty-list">Ancora nessuna categoria.</p> : null}
              </div>
            </div>
          </section>

          <section className="reviews-panel reviews-panel--wide">
            <div className="reviews-panel__head">
              <h2>Recensioni salvate</h2>
              <div className="reviews-panel__actions">
                <span className="reviews-muted">{reviews.length} totali</span>
                <fetcher.Form action="?index" method="post">
                  <input name="intent" type="hidden" value="dedupe-category-reviews" />
                  <button
                    className="reviews-button reviews-button--danger"
                    type="submit"
                    onClick={(event) => {
                      if (!window.confirm("Vuoi cancellare le recensioni doppie presenti nella stessa categoria?")) {
                        event.preventDefault();
                      }
                    }}
                  >
                    Cancella doppie categoria
                  </button>
                </fetcher.Form>
              </div>
            </div>
            <div className="reviews-list">
              {reviews.map((review) => (
                <article className={`reviews-row ${review.published ? "" : "is-muted"}`} key={review.id}>
                  <div>
                    <div className="reviews-stars">{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</div>
                    <h3>{review.title}</h3>
                    <p>{review.body}</p>
                    <small>{review.authorName}{review.authorType ? ` · ${review.authorType}` : ""}{review.productTitle ? ` · ${review.productTitle}` : ""}{review.categoryName ? ` · ${review.categoryName}` : ""}</small>
                  </div>
                  {review.photoUrl ? <img src={review.photoUrl} alt="" /> : <span className="reviews-photo-empty">No foto</span>}
                  <div className="reviews-row-actions">
                    <fetcher.Form action="?index" method="post">
                      <input name="intent" type="hidden" value="toggle" />
                      <input name="id" type="hidden" value={review.id} />
                      <input name="published" type="hidden" value={String(!review.published)} />
                      <button className="reviews-button" type="submit">{review.published ? "Nascondi" : "Pubblica"}</button>
                    </fetcher.Form>
                    <fetcher.Form action="?index" method="post">
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
    categoryId: review.categoryId,
    categoryName: review.category?.name ?? null,
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

function mapCategory(category: any): ReviewCategorySummary {
  return {
    id: category.id,
    key: category.key,
    name: category.name,
    productIds: category.productIds,
    productHandles: category.productHandles,
  };
}

function parseSelectedProduct(value: string): ProductOption {
  try {
    const product = JSON.parse(value);
    return { id: String(product.id ?? ""), title: String(product.title ?? ""), handle: String(product.handle ?? "") };
  } catch {
    return emptyProductOption();
  }
}

function emptyProductOption(): ProductOption {
  return { id: "", title: "", handle: "" };
}

function normalizeReview(input: ProductReviewInput): ProductReviewInput {
  return {
    ...input,
    categoryId: clean(input.categoryId),
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

function stripEmptyCategoryId(review: ProductReviewInput) {
  if (review.categoryId) return review;
  const { categoryId: _categoryId, ...reviewWithoutCategory } = review;
  return reviewWithoutCategory;
}

function toLegacyReviewInput(review: ProductReviewInput) {
  return {
    shop: review.shop,
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
  };
}

function normalizeDuplicateText(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function validateReview(review: ProductReviewInput) {
  const errors: string[] = [];
  if (!review.categoryId && !review.productId && !review.productHandle) {
    errors.push("Seleziona un prodotto, una categoria o indica un handle nel CSV.");
  }
  if (!review.title) errors.push("Inserisci il titolo della recensione.");
  if (!review.body) errors.push("Inserisci il testo della recensione.");
  if (!review.authorName) errors.push("Inserisci il nome cliente.");
  return errors;
}

function normalizeListText(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

async function runDatabaseWrite<T>(label: string, operation: () => Promise<T>) {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`WOWstampa reviews ${label} failed on attempt ${attempt}`, error);

      if (attempt === maxAttempts || !isRetryableDatabaseError(error)) break;
      await delay(250 * attempt);
    }
  }

  throw lastError;
}

function isRetryableDatabaseError(error: unknown) {
  const message = getErrorText(error).toLowerCase();
  return [
    "p1001",
    "p1002",
    "p1017",
    "p2024",
    "p2034",
    "prepared statement",
    "can't reach database",
    "connection",
    "connect",
    "closed",
    "pool",
    "timeout",
    "timed out",
  ].some((token) => message.includes(token));
}

function isLegacySchemaError(error: unknown) {
  const message = getErrorText(error).toLowerCase();
  return [
    "unknown argument",
    "unknown field",
    "does not exist",
    "column",
    "categoryid",
    "reviewdate",
  ].some((token) => message.includes(token));
}

function getErrorText(error: unknown) {
  if (!error) return "";
  if (error instanceof Error) return `${error.name} ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(value: unknown, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "si", "sì", "published", "pubblicata"].includes(text);
}

function createCategoryLookup(categories: any[]) {
  const lookup = new Map<string, string>();

  categories.forEach((category) => {
    const id = String(category.id ?? "");
    if (!id) return;

    getCategoryLookupKeys(category.key).forEach((key) => lookup.set(key, id));
    getCategoryLookupKeys(category.name).forEach((key) => lookup.set(key, id));
  });

  return lookup;
}

function getCategoryLookupKeys(value: unknown) {
  const text = String(value ?? "").trim();
  return [text.toLowerCase(), slugify(text)].filter(Boolean);
}

function rowToReview(row: Record<string, string>, shop: string, categoriesByName = new Map<string, string>()) {
  const categoryValue = row.categoria || row.category || row.category_name || row.categoryName || row.category_key || row.categoryKey || "";
  const categoryId = getCategoryLookupKeys(categoryValue)
    .map((key) => categoriesByName.get(key))
    .find(Boolean);

  if (categoryValue && !categoryId) return null;

  const review = normalizeReview({
    shop,
    categoryId: categoryId ?? null,
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
  .reviews-hero, .reviews-panel, .reviews-errors, .reviews-success { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 1px 0 rgba(0,0,0,.04); padding: 18px; }
  .reviews-hero { display: flex; justify-content: space-between; gap: 18px; align-items: center; }
  .reviews-hero h1, .reviews-panel h2, .reviews-row h3 { color: #202223; margin: 0; }
  .reviews-hero p, .reviews-muted, .reviews-row p { color: #6d7175; }
  .reviews-kicker { color: #008060; font-size: 12px; font-weight: 800; margin: 0 0 4px; text-transform: uppercase; }
  .reviews-stat { align-items: center; background: #edf7f4; border-radius: 12px; color: #006c52; display: grid; justify-items: center; min-width: 128px; padding: 16px; }
  .reviews-stat span { color: #202223; font-size: 44px; font-weight: 850; line-height: 1; }
  .reviews-stat strong { font-size: 28px; }
  .reviews-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .8fr); gap: 18px; align-items: start; }
  .reviews-panel__head { align-items: center; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .reviews-panel__actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
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
  .reviews-notice { background: #edf7f4; border: 1px solid #95c9b4; border-radius: 6px; color: #0c5132; font-size: 13px; font-weight: 700; margin-bottom: 12px; padding: 10px; }
  .reviews-errors { background: #fff4f4; border-color: #fed3d1; color: #8e1f0b; }
  .reviews-errors p { margin: 0; }
  .reviews-success { background: #f1f8f5; border-color: #95c9b4; color: #0c5132; }
  .reviews-success p { margin: 0; }
  .reviews-panel--wide { padding: 0; }
  .reviews-panel--wide .reviews-panel__head { border-bottom: 1px solid #dfe3e8; margin: 0; padding: 18px; }
  .reviews-category-layout { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1fr); gap: 18px; padding: 18px; }
  .reviews-category-form { border: 1px solid #dfe3e8; border-radius: 8px; padding: 14px; }
  .reviews-category-list { display: grid; gap: 10px; align-content: start; }
  .reviews-category-row { align-items: start; border: 1px solid #dfe3e8; border-radius: 8px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; padding: 14px; }
  .reviews-category-edit { display: grid; gap: 10px; }
  .reviews-category-edit .reviews-field { margin-bottom: 0; }
  .reviews-category-edit .reviews-button { justify-self: start; }
  .reviews-category-delete { padding-top: 25px; }
  .reviews-category-row h3 { margin: 0; }
  .reviews-category-row p { margin: 6px 0 0; white-space: pre-line; }
  .reviews-list { display: grid; }
  .reviews-row { align-items: center; border-bottom: 1px solid #dfe3e8; display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) 110px auto; padding: 16px 18px; }
  .reviews-row.is-muted { opacity: .55; }
  .reviews-stars { color: #ffb72b; font-weight: 900; margin-bottom: 4px; }
  .reviews-row img, .reviews-photo-empty { border-radius: 8px; height: 74px; object-fit: cover; width: 110px; }
  .reviews-photo-empty { align-items: center; background: #f6f6f7; color: #6d7175; display: flex; justify-content: center; font-size: 12px; font-weight: 700; }
  .reviews-row-actions { display: flex; gap: 8px; }
  .reviews-empty-list { padding: 18px; }
  @media (max-width: 900px) { .reviews-hero, .reviews-grid, .reviews-category-layout, .reviews-category-row, .reviews-row { grid-template-columns: 1fr; display: grid; } .reviews-field-grid { grid-template-columns: 1fr; } }
`;

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
