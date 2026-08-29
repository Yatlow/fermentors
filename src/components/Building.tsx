import { Hammer, Drill } from "lucide-react";
import { useEffect, useState } from "react";

export default function Building() {
    const [swapped, setSwapped] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            setSwapped(prev => !prev);
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    return (
        <div className="swap-container">

            <div className={`box ${!swapped ? "visible" : "hidden"}`}>
                <Hammer size={100} />
            </div>

            <div className={`box ${swapped ? "visible" : "hidden"}`}>
                <Drill size={100} />
            </div>

        </div>
    );
}