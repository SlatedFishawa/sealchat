package api

import (
	"bufio"
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"sealchat/model"
	"sealchat/service"
)

func TheaterResourceUpload(c *fiber.Ctx) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		return theaterErrorResponse(c, requestID, service.NewTheaterPayloadErrorForAPI("file 必填"))
	}
	file, err := fileHeader.Open()
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	defer file.Close()
	result, err := service.CreateTheaterResourceUpload(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), service.TheaterResourceUploadInput{Reader: file, Size: fileHeader.Size, Filename: fileHeader.Filename, ClientResourceID: c.FormValue("clientResourceId"), MediaKind: c.FormValue("mediaKind"), ProcessingProfile: c.FormValue("processingProfile"), TargetObjectID: c.FormValue("targetObjectId")})
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	status := fiber.StatusAccepted
	if result.Deduplicated && result.Resource.Status == "ready" {
		status = fiber.StatusOK
	}
	return c.Status(status).JSON(fiber.Map{"ok": true, "requestId": requestID, "resource": result.Resource, "deduplicated": result.Deduplicated})
}

func TheaterResourceGet(c *fiber.Ctx) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	resource, err := service.GetTheaterResource(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId"))
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	return c.JSON(fiber.Map{"ok": true, "requestId": requestID, "resource": resource})
}

func TheaterResourceProcessingGet(c *fiber.Ctx) error {
	return TheaterResourceGet(c)
}

func TheaterResourceRetry(c *fiber.Ctx) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	var body struct {
		ProcessingRequestID string `json:"processingRequestId"`
	}
	if err := decodeTheaterBody(c, &body, 64<<10); err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	resource, err := service.RetryTheaterResource(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId"), body.ProcessingRequestID)
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"ok": true, "requestId": requestID, "resource": resource})
}

func TheaterResourceDelete(c *fiber.Ctx) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	if err := service.DeleteTheaterResource(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId")); err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	return c.Status(fiber.StatusNoContent).Send(nil)
}

func TheaterResourceContent(c *fiber.Ctx) error {
	return theaterResourceContent(c, "")
}

func TheaterResourceVariantContent(c *fiber.Ctx) error {
	return theaterResourceContent(c, c.Params("variant"))
}

func TheaterResourceContentURL(c *fiber.Ctx) error {
	return theaterResourceContentURL(c, "")
}

func TheaterResourceVariantContentURL(c *fiber.Ctx) error {
	return theaterResourceContentURL(c, c.Params("variant"))
}

func theaterResourceContentURL(c *fiber.Ctx, variant string) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	content, err := service.ResolveTheaterResourceContent(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId"), variant)
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	if content.Attachment.StorageType != model.StorageS3 {
		return c.JSON(fiber.Map{"url": ""})
	}
	if target := service.AttachmentReadURL(c.Context(), content.Attachment); target != "" {
		return c.JSON(fiber.Map{"url": target})
	}
	return theaterErrorResponse(c, requestID, errors.New("S3 content unavailable"))
}

func theaterResourceContent(c *fiber.Ctx, variant string) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	content, err := service.ResolveTheaterResourceContent(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId"), variant)
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	return serveTheaterResourceContent(c, requestID, content)
}

// TheaterResourceThumbnail returns a static WebP preview of a room resource.
// GET .../theater/resources/:resourceId/thumbnail?size=150
func TheaterResourceThumbnail(c *fiber.Ctx) error {
	requestID := theaterRequestID(c)
	user := getCurUser(c)
	content, err := service.ResolveTheaterResourceThumbnailSource(c.Context(), user.ID, c.Params("worldId"), c.Params("channelId"), c.Params("resourceId"))
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	return serveTheaterResourceThumbnail(c, requestID, content)
}

// serveTheaterResourceThumbnail reuses the attachment thumbnail resize cache.
// Static sources fall back to their stored content like AttachmentThumb;
// animated sources never do, because the preview must stay a still frame.
func serveTheaterResourceThumbnail(c *fiber.Ctx, requestID string, content *service.TheaterResourceContent) error {
	attachment := content.Attachment
	animated := service.IsTheaterThumbnailSourceAnimated(content)
	// Remote originals would redirect to object storage; resize those instead.
	if !animated && attachment.StorageType != model.StorageS3 && attachment.Size > 0 && attachment.Size < thumbnailSizeThreshold {
		return serveTheaterResourceContent(c, requestID, content)
	}
	size := thumbnailSizeFromQuery(c)
	cacheKey := attachment.ID
	if animated {
		cacheKey += "_still"
	}
	thumbPath := getThumbCachePath(cacheKey, size)
	if _, err := os.Stat(thumbPath); err != nil {
		sourcePath, cleanup, err := service.OpenTheaterAttachmentLocalPath(c.Context(), attachment)
		if err == nil {
			err = generateThumbnail(sourcePath, thumbPath, size)
			cleanup()
		}
		if err != nil {
			if animated {
				return theaterErrorResponse(c, requestID, &service.TheaterError{Code: service.TheaterErrorResourceThumbnailUnavailable, Message: "资源没有可用缩略图", HTTPStatus: fiber.StatusNotFound})
			}
			return serveTheaterResourceContent(c, requestID, content)
		}
	}
	c.Set(fiber.HeaderCacheControl, "private, max-age=3600")
	c.Set(fiber.HeaderContentType, "image/webp")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.SendFile(thumbPath)
}

func serveTheaterResourceContent(c *fiber.Ctx, requestID string, content *service.TheaterResourceContent) error {
	attachment := content.Attachment
	if attachment.StorageType == model.StorageS3 {
		if target := service.AttachmentReadURL(c.Context(), attachment); target != "" {
			return c.Redirect(target, fiber.StatusFound)
		}
		return theaterErrorResponse(c, requestID, errors.New("S3 content unavailable"))
	}
	path, err := service.ResolveLocalAttachmentPath(attachment.ObjectKey)
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	file, err := os.Open(path)
	if err != nil {
		return theaterErrorResponse(c, requestID, err)
	}
	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return theaterErrorResponse(c, requestID, err)
	}
	mimeType := attachment.MimeType
	if content.Variant != nil && content.Variant.MimeType != "" {
		mimeType = content.Variant.MimeType
	}
	c.Set(fiber.HeaderContentType, mimeType)
	c.Set("X-Content-Type-Options", "nosniff")
	contentHash := content.Resource.ContentHash
	if content.Variant != nil && content.Variant.ContentHash != "" {
		contentHash = content.Variant.ContentHash
	}
	c.Set(fiber.HeaderETag, `"`+contentHash+`"`)
	c.Set("Accept-Ranges", "bytes")
	if strings.HasPrefix(mimeType, "image/") || strings.HasPrefix(mimeType, "video/") {
		c.Set(fiber.HeaderContentDisposition, "inline")
	}
	if c.Get(fiber.HeaderRange) != "" {
		return streamFileWithRange(c, file, stat.Size(), mimeType)
	}
	c.Set(fiber.HeaderContentLength, strconv.FormatInt(stat.Size(), 10))
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer file.Close()
		_, _ = writer.ReadFrom(file)
	})
	return nil
}
