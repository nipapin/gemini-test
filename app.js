import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const S3_ENDPOINT = process.env.S3_URL;
const S3_BUCKET = process.env.S3_BUCKET || process.env.BUCKET_NAME;
const S3_REGION = process.env.S3_REGION || "ru-1";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;

if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error(
        "[FATAL] S3 config is incomplete. Required env vars: S3_URL, S3_BUCKET (or BUCKET_NAME), S3_ACCESS_KEY, S3_SECRET_KEY (S3_REGION optional)"
    );
    process.exit(1);
}

const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    },
});

const RESTORED_PREFIX = "restorations/";

const Logger = {
    info: (...args) => console.log("[INFO]", ...args),
    error: (...args) => console.error("[ERROR]", ...args),
};

const restorationSystemInstruction = `You are a world-class professional photo restoration specialist. Your sole task is to restore old, damaged, faded, or low-quality photographs while preserving the original identity and content.

## CORE MISSION
Restore the provided photograph to a clean, high-quality version of itself. Treat the image as a real historical artifact: respect what is there, do not invent.

## WHAT TO DO
- Remove physical damage: scratches, cracks, tears, dust, stains, fingerprints, water damage, mold, fold lines
- Remove digital damage: noise, compression artifacts, JPEG blocking, banding, chromatic aberration
- Reconstruct missing or torn regions plausibly, matching surrounding texture, lighting, and content
- Fix fading and yellowing: restore natural, balanced colors. If the photo is black-and-white, keep it black-and-white with a clean neutral tone (do NOT colorize unless explicitly asked)
- Recover detail in shadows and highlights without crushing or blowing them out
- Gently sharpen faces, eyes, and key details so they are clear but still natural
- Improve overall contrast and tonal range to look like a well-preserved original print
- Denoise skin and smooth grain while keeping realistic skin texture (no plastic / over-smoothed faces)

## WHAT TO PRESERVE (NON-NEGOTIABLE)
- Identity of every person: face structure, features, age, hairstyle, expression, body proportions
- Original composition, framing, aspect ratio, and camera angle
- Original clothing, accessories, objects, background, and setting
- Era-appropriate look (a 1950s photo should still look like a 1950s photo, just clean)
- Original lighting direction and mood

## WHAT NOT TO DO
- Do NOT change anyone's face, age, gender, ethnicity, or expression
- Do NOT add, remove, or move people or objects
- Do NOT colorize black-and-white photos unless explicitly requested
- Do NOT modernize clothing, hairstyles, or background
- Do NOT add text, watermarks, logos, frames, borders, or captions
- Do NOT apply heavy stylization, HDR, oversaturation, or "Instagram filter" looks
- Do NOT crop or change aspect ratio

## OUTPUT
Return ONLY the restored image. The result must look like a faithful, professionally restored version of the original photograph — natural, realistic, and respectful of the source.`;

const genai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    vertexai: false,
});

const resizeToOriginalSize = async (buffer, sourceBuffer) => {
    const { width, height } = await sharp(sourceBuffer).metadata();
    return await sharp(buffer).resize(width, height).toBuffer();
};

const uploadToS3 = async (key, body, contentType) => {
    await s3.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
        })
    );
};

const restoreImage = async ({ buffer, mimeType, userPrompt }) => {
    const promptText =
        userPrompt && userPrompt.trim()
            ? userPrompt.trim()
            : "Restore this photograph. Remove all damage and signs of aging while keeping every person, object, and detail exactly as in the original.";

    const contents = [
        { inlineData: { mimeType, data: buffer.toString("base64") } },
        { text: promptText },
    ];

    const response = await genai.models.generateContent({
        model: "gemini-3-pro-image-preview",
        contents,
        config: {
            responseModalities: ["IMAGE"],
            systemInstruction: restorationSystemInstruction,
            thinkingConfig: {
                includeThoughts: false,
                thinkingBudget: 0,
            },
        },
    });

    const content = response.candidates?.[0]?.content;
    if (!content?.parts) {
        Logger.error("restoreImage: empty response content");
        return null;
    }

    for (const part of content.parts) {
        if (part.inlineData) {
            const fileName = crypto.randomUUID() + ".png";
            const restoredBuffer = Buffer.from(part.inlineData.data, "base64");
            const finalBuffer = await resizeToOriginalSize(restoredBuffer, buffer);
            await uploadToS3(`${RESTORED_PREFIX}${fileName}`, finalBuffer, "image/png");
            Logger.info("restoreImage: uploaded to S3", fileName);
            return fileName;
        }
    }
    Logger.error("restoreImage: no image in response");
    return null;
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) {
            return cb(new Error("Only image files are allowed"));
        }
        cb(null, true);
    },
});

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.post("/api/restore", upload.single("photo"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }
        Logger.info("restore request", {
            originalName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype,
        });
        const fileName = await restoreImage({
            buffer: req.file.buffer,
            mimeType: req.file.mimetype || "image/jpeg",
            userPrompt: (req.body?.prompt || "").toString(),
        });
        if (!fileName) {
            return res.status(500).json({ error: "Restoration failed" });
        }
        return res.json({ restored: `/restorations/${fileName}` });
    } catch (err) {
        Logger.error("restore error", err);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

app.get("/restorations/:key", async (req, res) => {
    const safeKey = req.params.key.replace(/[^\w.\-]/g, "");
    if (!safeKey || safeKey !== req.params.key) {
        return res.status(400).end();
    }
    const key = `${RESTORED_PREFIX}${safeKey}`;
    try {
        const out = await s3.send(
            new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
        );
        if (out.ContentType) res.setHeader("Content-Type", out.ContentType);
        if (out.ContentLength) res.setHeader("Content-Length", String(out.ContentLength));
        if (out.LastModified) res.setHeader("Last-Modified", out.LastModified.toUTCString());
        if (out.ETag) res.setHeader("ETag", out.ETag);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

        const body = out.Body;
        if (body instanceof Readable) {
            body.on("error", (err) => {
                Logger.error("s3 stream error", { key, err: err.message });
                if (!res.headersSent) res.status(502).end();
            });
            body.pipe(res);
        } else if (body && typeof body.transformToByteArray === "function") {
            res.end(Buffer.from(await body.transformToByteArray()));
        } else {
            res.status(500).end();
        }
    } catch (err) {
        if (err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchKey") {
            return res.status(404).end();
        }
        Logger.error("serve restoration error", { key, err: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/gallery", async (_req, res) => {
    try {
        const { Contents = [] } = await s3.send(
            new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: RESTORED_PREFIX,
                MaxKeys: 500,
            })
        );
        const items = Contents.filter((o) => /\.(png|jpe?g|webp)$/i.test(o.Key || ""))
            .map((o) => {
                const name = o.Key.slice(RESTORED_PREFIX.length);
                return {
                    name,
                    url: `/restorations/${name}`,
                    mtime: o.LastModified?.getTime() ?? 0,
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json({ items });
    } catch (err) {
        Logger.error("gallery error", err);
        res.status(500).json({ error: err.message });
    }
});

const server = app.listen(PORT, () => {
    Logger.info(`Photo restoration server is running at http://localhost:${PORT}`);
    Logger.info(`S3 endpoint: ${S3_ENDPOINT} (bucket: ${S3_BUCKET}, region: ${S3_REGION})`);
});
server.requestTimeout = 0;
server.headersTimeout = 120_000;
