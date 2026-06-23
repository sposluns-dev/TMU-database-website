interface BackgroundProps {
    children: React.ReactNode;
}

export const Background = ({ children }: BackgroundProps) => {
    return (
        <div className="background-wrapper">
            <div className="background-layer primary" />
            {/* Content container */}
            <div className="background-content">{children}</div>
        </div>
    );
};
