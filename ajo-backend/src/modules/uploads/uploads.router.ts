import { Router } from 'express';
import multer from 'multer';
import { HttpError } from '../../lib/errors';
import { authenticate } from '../../middleware/auth.middleware';
import { saveFile } from '../../services/storage.service';

export const uploadRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/3gpp': '3gp' };

/** Proof-of-payment / avatar / product images. Stored on local disk; returns a public URL. */
uploadRouter.post('/', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'file is required');
  const ext = EXT[req.file.mimetype];
  if (!ext) throw new HttpError(400, 'Only images, PDFs or voice notes are allowed');
  const url = await saveFile(req.file.buffer, 'ajo/uploads', ext);
  res.status(201).json({ url });
});
