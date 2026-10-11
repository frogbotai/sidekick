import { z } from 'zod';

import { defineStorageItem } from './item';

export const theme = defineStorageItem('theme', z.enum(['light', 'dark', 'system']), 'system');
