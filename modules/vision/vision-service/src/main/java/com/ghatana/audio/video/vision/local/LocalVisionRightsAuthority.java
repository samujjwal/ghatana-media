package com.ghatana.audio.video.vision.local;

/**
 * Injectable port for the rights and consent authority that must stand behind production use of the
 * local vision models. Model digest qualification says the weights are the licensed ones; it says
 * nothing about whether a particular media source may be processed. Until a real authority is wired,
 * the provider is never production eligible and reports {@link #UNAVAILABLE_CODE}.
 *
 * @doc.type interface
 * @doc.purpose Rights authority port for local vision provider production eligibility
 * @doc.layer product
 * @doc.pattern Port
 */
public interface LocalVisionRightsAuthority {

    String UNAVAILABLE_CODE = "RIGHTS_AUTHORITY_UNAVAILABLE";

    /** True only when a real rights/consent authority is ready for production admission. */
    boolean productionReady();

    /** Stable reason code while {@link #productionReady()} is false. */
    String reasonCode();

    /** The default: no authority exists, so production use is not admitted. */
    static LocalVisionRightsAuthority unavailable() {
        return new LocalVisionRightsAuthority() {
            @Override public boolean productionReady() { return false; }
            @Override public String reasonCode() { return UNAVAILABLE_CODE; }
        };
    }
}
