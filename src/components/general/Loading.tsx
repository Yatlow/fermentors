type BeerLoaderProps = {
    message?: string;
    size?: "small" | "medium" | "large" | "spinner";
    overlay?: boolean;
};

export default function BeerLoader({
    message = "רק רגע…",
    size = "medium",
    overlay = false,
}: BeerLoaderProps) {
    const content = (
        <div
            className={`beer-loader beer-loader-${size}`}
            dir="rtl"
        >
            {size === "spinner" ? (
                <div className="beer-spinner">
                    <span>🍺</span>
                </div>
            ) : (
                <div className="beer-glass">
                    <div className="beer-liquid">
                        <span className="beer-bubble b1" />
                        <span className="beer-bubble b2" />
                        <span className="beer-bubble b3" />
                    </div>

                    <div className="beer-foam">
                        <i />
                        <i />
                        <i />
                    </div>
                </div>
            )}

            {message && (
                <div className="beer-loader-message">
                    {message}
                </div>
            )}
        </div>
    );

    if (!overlay) {
        return content;
    }

    return (
        <div className="beer-loader-overlay">
            {content}
        </div>
    );
}