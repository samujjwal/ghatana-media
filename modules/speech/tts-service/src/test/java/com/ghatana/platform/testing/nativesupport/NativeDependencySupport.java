package com.ghatana.platform.testing.nativesupport;

import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Local stub — tts-service Java 17 can't depend on platform:java:testing (Java 21). 
 */
public class NativeDependencySupport {

    @Target({ElementType.TYPE, ElementType.METHOD}) 
    @Retention(RetentionPolicy.RUNTIME) 
    @ExtendWith(NativeDependencyCondition.class) 
    public @interface RequireNative {
        NativeType value() default NativeType.ANY; 
        String message() default "Native dependencies not available"; 
    }

    public enum NativeType {
        WHISPER_CPP, COQUI_TTS, ANY
    }

    static class NativeDependencyCondition implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) { 
            return ConditionEvaluationResult.disabled("Native dependencies not available in test environment");
        }
    }
}
