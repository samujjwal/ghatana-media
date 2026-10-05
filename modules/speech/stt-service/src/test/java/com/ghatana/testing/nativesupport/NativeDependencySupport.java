package com.ghatana.testing.nativesupport;

import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Local stub for NativeDependencySupport.
 * Mirrors platform:java:testing but avoids Java 21 dependency for this Java 17 module.
 */
public class NativeDependencySupport {

    @Target({ElementType.TYPE, ElementType.METHOD}) 
    @Retention(RetentionPolicy.RUNTIME) 
    @ExtendWith(NativeDependencyCondition.class) 
    public @interface RequireNative {
        /**
         * Required native dependency type.
         */
        NativeType value() default NativeType.ANY; 

        /**
         * Optional custom disable reason displayed by JUnit.
         */
        String message() default "Native dependencies not available"; 
    }

    public enum NativeType {
        WHISPER_CPP,
        COQUI_TTS,
        ANY
    }

    public static class NativeDependencyCondition implements ExecutionCondition {

        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) { 
            RequireNative annotation = context.getElement() 
                .map(el -> el.getAnnotation(RequireNative.class)) 
                .orElse(null); 

            if (annotation == null) { 
                return ConditionEvaluationResult.enabled("No @RequireNative annotation");
            }

            NativeType requiredType = annotation.value(); 
            String customMessage = annotation.message(); 

            if (isNativeAvailable(requiredType)) { 
                return ConditionEvaluationResult.enabled("Native dependencies available");
            } else {
                String message = String.format("%s: %s not available", 
                    customMessage, requiredType);
                return ConditionEvaluationResult.disabled(message); 
            }
        }
    }

    private static boolean isNativeAvailable(NativeType type) { 
        switch (type) { 
            case WHISPER_CPP:
                return isClassAvailable("com.ghatana.stt.core.whisper.WhisperCppAdapter");
            case COQUI_TTS:
                return isClassAvailable("com.ghatana.tts.core.coqui.CoquiTTSAdapter");
            case ANY:
                return isClassAvailable("com.ghatana.stt.core.whisper.WhisperCppAdapter")
                    || isClassAvailable("com.ghatana.tts.core.coqui.CoquiTTSAdapter");
            default:
                return false;
        }
    }

    private static boolean isClassAvailable(String className) { 
        try {
            Class<?> clazz = Class.forName(className); 
            try {
                java.lang.reflect.Field field = clazz.getDeclaredField("NATIVE_LIBRARY_AVAILABLE");
                field.setAccessible(true); 
                return field.getBoolean(null); 
            } catch (NoSuchFieldException | IllegalAccessException e) { 
                return true;
            }
        } catch (ClassNotFoundException | NoClassDefFoundError | UnsatisfiedLinkError e) { 
            return false;
        }
    }
}
