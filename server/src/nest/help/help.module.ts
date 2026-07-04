import { Module } from '@nestjs/common';
import { HelpController } from './help.controller';

/** /api/help — embedded GitHub wiki (fetched + cached in wikiService). */
@Module({
  controllers: [HelpController],
})
export class HelpModule {}
