package com.ghatana.media.provider.aws;

/** Thrown when a review case has exhausted the signed 64-bit revision space. */
public final class ReviewRevisionOverflowException extends ArithmeticException {
    public ReviewRevisionOverflowException() {
        super("review case revision cannot be incremented beyond Long.MAX_VALUE");
    }
}
