import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import mime from "mime-types";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, "uploads");
const RESTORATIONS_DIR = path.join(ROOT, "restorations");
const PUBLIC_DIR = path.join(ROOT, "public");

for (const dir of [UPLOADS_DIR, RESTORATIONS_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

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

const restoreImage = async ({ base64Image, mimeType, userPrompt }) => {
    const promptText = userPrompt && userPrompt.trim()
        ? userPrompt.trim()
        : "Restore this photograph. Remove all damage and signs of aging while keeping every person, object, and detail exactly as in the original.";

    const contents = [
        { inlineData: { mimeType, data: base64Image } },
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

    const candidate = response.candidates?.[0];
    const content = candidate?.content;
    if (!content?.parts) {
        Logger.error("restoreImage: empty response content");
        return null;
    }

    for (const part of content.parts) {
        if (part.inlineData) {
            const fileName = crypto.randomUUID() + ".png";
            const filePath = path.join(RESTORATIONS_DIR, fileName);
            const buffer = Buffer.from(part.inlineData.data, "base64");
            const sourceBuffer = Buffer.from(base64Image, "base64");
            fs.writeFileSync(filePath, await resizeToOriginalSize(buffer, sourceBuffer));
            Logger.info("restoreImage: saved", fileName);
            return fileName;
        }
    }
    Logger.error("restoreImage: no image in response");
    return null;
};

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname) || ".jpg";
            cb(null, crypto.randomUUID() + ext);
        },
    }),
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
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/restorations", express.static(RESTORATIONS_DIR));

app.post("/api/restore", upload.single("photo"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }
        const uploadedPath = req.file.path;
        const base64Image = fs.readFileSync(uploadedPath, "base64");
        const mimeType = req.file.mimetype || mime.lookup(uploadedPath) || "image/jpeg";
        const userPrompt = (req.body?.prompt || "").toString();

        Logger.info("restore request", { file: req.file.filename, mimeType, userPrompt });

        const fileName = await restoreImage({ base64Image, mimeType, userPrompt });
        if (!fileName) {
            return res.status(500).json({ error: "Restoration failed" });
        }

        return res.json({
            original: `/uploads/${req.file.filename}`,
            restored: `/restorations/${fileName}`,
        });
    } catch (err) {
        Logger.error("restore error", err);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

app.get("/api/gallery", (_req, res) => {
    try {
        const files = fs
            .readdirSync(RESTORATIONS_DIR)
            .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
            .map((f) => {
                const full = path.join(RESTORATIONS_DIR, f);
                const stat = fs.statSync(full);
                return { name: f, url: `/restorations/${f}`, mtime: stat.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json({ items: files });
    } catch (err) {
        Logger.error("gallery error", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    Logger.info(`Photo restoration server is running at http://localhost:${PORT}`);
});
