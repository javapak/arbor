/** A problem in an expression, at offsets in its text. Codes are stable, like arbor's ARB codes. */
export interface ExprDiagnostic {
    code: string;
    severity: 'error' | 'warning';
    message: string;
    start: number;
    end: number;
}

export const DiagnosticCode = {
    Syntax: 'EXP001',
    UnknownName: 'EXP002',
    UnknownMember: 'EXP003',
    TypeMismatch: 'EXP004',
    BadArguments: 'EXP005',
    SideEffect: 'EXP006',
    NotAssignable: 'EXP007',
    BadReturn: 'EXP008',
} as const;
