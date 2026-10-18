import { z } from 'zod';

/** MongoDB ObjectId as a 24-char hex string. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
