CREATE TABLE "ReviewCategory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productIds" TEXT NOT NULL DEFAULT '',
    "productHandles" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCategory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductReview" ADD COLUMN "categoryId" TEXT;

CREATE UNIQUE INDEX "ReviewCategory_shop_key_key" ON "ReviewCategory"("shop", "key");
CREATE INDEX "ReviewCategory_shop_idx" ON "ReviewCategory"("shop");
CREATE INDEX "ProductReview_shop_categoryId_idx" ON "ProductReview"("shop", "categoryId");

ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "ReviewCategory"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
