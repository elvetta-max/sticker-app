-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "target_version" INTEGER NOT NULL DEFAULT 1,
    "force_update" BOOLEAN NOT NULL DEFAULT false,
    "maintenance_mode" BOOLEAN NOT NULL DEFAULT false,
    "ads_enabled" BOOLEAN NOT NULL DEFAULT true,
    "admob_banner" TEXT,
    "admob_interstitial" TEXT,
    "admob_rewarded" TEXT,
    "admob_rewarded_interstitial" TEXT,
    "admob_openad" TEXT,
    "admob_native" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceProfile" (
    "device_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "fcm_token" TEXT,
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_active_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "streak_count" INTEGER NOT NULL DEFAULT 0,
    "last_streak_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceProfile_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "cloudinary_public_id" TEXT NOT NULL,
    "is_animated" BOOLEAN NOT NULL DEFAULT false,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "emojis" TEXT[],
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchQuery" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "image_id" TEXT,
    "keyword" TEXT,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminApp" (
    "admin_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,

    CONSTRAINT "AdminApp_pkey" PRIMARY KEY ("admin_id","app_id")
);

-- CreateTable
CREATE TABLE "_ImageToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ImageToTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "App_package_name_key" ON "App"("package_name");

-- CreateIndex
CREATE INDEX "DeviceProfile_app_id_idx" ON "DeviceProfile"("app_id");

-- CreateIndex
CREATE INDEX "DeviceProfile_app_id_last_active_date_idx" ON "DeviceProfile"("app_id", "last_active_date");

-- CreateIndex
CREATE INDEX "Image_app_id_idx" ON "Image"("app_id");

-- CreateIndex
CREATE INDEX "Image_app_id_created_at_idx" ON "Image"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "Image_app_id_downloads_shares_idx" ON "Image"("app_id", "downloads", "shares");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "SearchQuery_app_id_created_at_idx" ON "SearchQuery"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "Favorite_app_id_device_id_idx" ON "Favorite"("app_id", "device_id");

-- CreateIndex
CREATE INDEX "Favorite_created_at_idx" ON "Favorite"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_device_id_image_id_key" ON "Favorite"("device_id", "image_id");

-- CreateIndex
CREATE INDEX "Report_app_id_status_created_at_idx" ON "Report"("app_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Report_device_id_image_id_key" ON "Report"("device_id", "image_id");

-- CreateIndex
CREATE INDEX "NotificationLog_app_id_type_created_at_idx" ON "NotificationLog"("app_id", "type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_device_id_day_key" ON "NotificationLog"("device_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_username_key" ON "Admin"("username");

-- CreateIndex
CREATE INDEX "AdminApp_app_id_idx" ON "AdminApp"("app_id");

-- CreateIndex
CREATE INDEX "_ImageToTag_B_index" ON "_ImageToTag"("B");

-- AddForeignKey
ALTER TABLE "DeviceProfile" ADD CONSTRAINT "DeviceProfile_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchQuery" ADD CONSTRAINT "SearchQuery_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminApp" ADD CONSTRAINT "AdminApp_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminApp" ADD CONSTRAINT "AdminApp_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ImageToTag" ADD CONSTRAINT "_ImageToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ImageToTag" ADD CONSTRAINT "_ImageToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
