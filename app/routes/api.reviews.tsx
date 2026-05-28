import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

const reviewClient = (prisma as any).productReview;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.trim();
  const productId = url.searchParams.get("productId")?.trim();
  const productHandle = url.searchParams.get("productHandle")?.trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 50);

  if (!shop) return json({ reviews: [], error: "Missing shop parameter." }, 400);

  const productFilters = [];
  if (productId) {
    productFilters.push({ productId });
    if (/^\d+$/.test(productId)) productFilters.push({ productId: `gid://shopify/Product/${productId}` });
  }
  if (productHandle) productFilters.push({ productHandle });

  const reviews = await reviewClient.findMany({
    where: { shop, published: true, ...(productFilters.length ? { OR: productFilters } : {}) },
    orderBy: [{ reviewDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  const total = reviews.length;
  const average = total ? reviews.reduce((sum: number, review: any) => sum + review.rating, 0) / total : 0;
  const distribution = [5, 4, 3, 2, 1].map((rating) => {
    const count = reviews.filter((review: any) => review.rating === rating).length;
    return { rating, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });

  return json({
    average: Number(average.toFixed(1)),
    total,
    distribution,
    reviews: reviews.map((review: any) => ({
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
      reviewDate: review.reviewDate?.toISOString() ?? review.createdAt.toISOString(),
    })),
  });
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
