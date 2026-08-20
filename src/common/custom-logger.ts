import { ConsoleLogger, LogLevel } from '@nestjs/common';

type LogMessage =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Error
  | readonly LogMessage[]
  | { readonly [key: string]: LogMessage };
export class CustomLogger extends ConsoleLogger {
  protected getTimestamp(): string {
    return new Date().toLocaleString('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  protected formatMessage(
    logLevel: LogLevel,
    message: LogMessage,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const output = this.stringifyMessage(message, logLevel);
    const colorizedPid = this.colorize(pidMessage, logLevel);
    const colorizedLevel = this.colorize(formattedLogLevel.trim(), logLevel);
    return `${colorizedPid}${this.getTimestamp()}\n${colorizedLevel} ${contextMessage}${output}${timestampDiff}\n`;
  }
}
