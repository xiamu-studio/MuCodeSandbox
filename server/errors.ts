export class AppError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'INVALID_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Preserve the local SSH exit status without parsing arbitrary command output.
export class SshProcessError extends AppError {
  readonly exitStatus:number|null;
  constructor(message:string,exitStatus:number|null) {super(message,500,'PROCESS_FAILED');this.exitStatus=exitStatus;}
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
